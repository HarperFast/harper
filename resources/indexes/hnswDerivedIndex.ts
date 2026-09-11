import { ClientError } from '../../utility/errors/hdbError.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import type { Id } from '../ResourceInterface.ts';
import type { RocksTransactionLogStore } from '../RocksTransactionLogStore.ts';
import {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DerivedIndexRuntime,
	readDerivedIndexReadiness,
	type DerivedIndexBackend,
	type DerivedIndexBackendHost,
	type DerivedIndexBackendStateChange,
	type DerivedIndexBatch,
	type DerivedIndexCursor,
	type DerivedIndexDeliveryResult,
	type DerivedIndexFlushReason,
	type DerivedIndexMutation,
	type DerivedIndexReadiness,
} from '../derivedIndexRuntime.ts';

const logger = loggerWithTag('HNSW');

/** The one durable cursor vector of a file-primary HNSW index, stored beside its node mappings. */
export const DERIVED_INDEX_CURSOR_KEY = Symbol.for('derived-index-cursor');

// Bounds on the queue between the runtime's delivery and the native applier. The runtime already
// chunks a delivery by records and estimated bytes; this caps how many chunks may wait.
const QUEUE_CAPACITY_BYTES = 64 * 1024 * 1024;
const APPLY_SLICE_MILLIS = 5;
// Writes to an index this far behind fail with a retryable 503 (see the runtime's lag policy).
const DEFAULT_MAX_LAG_MILLISECONDS = 30_000;

/**
 * The native index methods the backend drives. `applyDerivedValue` inserts, replaces or removes
 * one primary key's vector and stages its mapping as pending; `flushDerived` is the durability
 * barrier that publishes the pending mappings; `resetDerivedStorage` destroys the native file.
 */
export interface DerivedNativeIndex {
	readonly indexStore: any;
	applyDerivedValue(primaryKey: Id, vector: number[] | undefined, version?: number): void;
	flushDerived(): Promise<void>;
	resetDerivedStorage(): void;
	assertDerivedValue(vector: unknown, label: string): void;
	attachDerivedHost(host: { readiness: () => DerivedIndexReadiness; requestRebuild: () => boolean }): void;
}

/**
 * `DerivedIndexBackend` over a file-primary HNSW index. `deliver()` only enqueues; an applier drains
 * the queue in bounded time slices so a 4096-record chunk at ~0.35 ms per native insert does not
 * hold the event loop for a second and a half. The barrier is the plane's `msync`, after which the
 * pending mappings and then the cursor vector are published — in that order, so a crash between
 * any two steps leaves a cursor that replays (idempotently) over a mapping that was never published,
 * never a published cursor over native state the barrier did not cover.
 */
export class HnswDerivedIndexBackend implements DerivedIndexBackend {
	readonly id: string;
	#index: DerivedNativeIndex;
	#host?: DerivedIndexBackendHost;
	#wake?: (change?: DerivedIndexBackendStateChange) => void;
	#queue: DerivedIndexBatch[] = [];
	#queuedBytes = 0;
	#position = 0;
	#scheduled = false;
	#appliedCursor?: DerivedIndexCursor;
	#appliedEpoch?: bigint;
	#flushRequested = false;
	#flushing?: Promise<void>;
	#resetting?: Promise<void>;
	#unindexable = 0;

	constructor(id: string, index: DerivedNativeIndex) {
		this.id = id;
		this.#index = index;
	}

	attach(host: DerivedIndexBackendHost): void {
		this.#host = host;
	}

	onStateChange(wake: (change?: DerivedIndexBackendStateChange) => void): () => void {
		this.#wake = wake;
		return () => {
			if (this.#wake === wake) this.#wake = undefined;
		};
	}

	getDurableCursor(): DerivedIndexCursor | undefined {
		const cursor = this.#index.indexStore.getSync(DERIVED_INDEX_CURSOR_KEY);
		return cursor === undefined ? undefined : (cursor as DerivedIndexCursor);
	}

	deliver(batch: DerivedIndexBatch): DerivedIndexDeliveryResult {
		if (this.#queuedBytes >= QUEUE_CAPACITY_BYTES) return DERIVED_INDEX_DEFERRED;
		this.#queue.push(batch);
		this.#queuedBytes += batch.bytes;
		this.#schedule();
		return DERIVED_INDEX_ACCEPTED;
	}

	flush(_reason: DerivedIndexFlushReason): void {
		this.#flushRequested = true;
		if (this.#queue.length === 0 && !this.#scheduled) this.#runFlush();
	}

	/**
	 * Drop what is queued and resolve once no barrier is in flight. The runtime quiesces an epoch
	 * before it mints the next, so nothing of a newer epoch can be queued here yet.
	 */
	async shutdown(_epoch: bigint): Promise<void> {
		this.#dropQueue();
		await this.#flushing;
		await this.#resetting;
	}

	/**
	 * The cursor goes first: a crash anywhere after this line reopens cursorless and rebuilds, never
	 * on a format-valid cursor over a destroyed graph.
	 */
	reset(_epoch: bigint): Promise<void> {
		this.#dropQueue();
		this.#appliedCursor = undefined;
		this.#resetting = (async () => {
			await this.#flushing;
			this.#index.indexStore.removeSync(DERIVED_INDEX_CURSOR_KEY);
			this.#index.resetDerivedStorage();
			await this.#index.indexStore.clear();
		})();
		return this.#resetting.finally(() => (this.#resetting = undefined));
	}

	#dropQueue() {
		this.#queue.length = 0;
		this.#queuedBytes = 0;
		this.#position = 0;
	}

	#schedule() {
		if (this.#scheduled) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			this.#applySlice();
		});
	}

	#applySlice() {
		// Application pauses while a barrier is in flight so the barrier publishes exactly the
		// mappings it covers; the flush reschedules application when it settles.
		if (this.#flushing) return;
		const host = this.#host!;
		const until = performance.now() + APPLY_SLICE_MILLIS;
		const wasFull = this.#queuedBytes >= QUEUE_CAPACITY_BYTES;
		while (this.#queue.length > 0 && performance.now() < until) {
			const batch = this.#queue[0];
			if (!host.isOwnerEpoch(batch.ownerEpoch)) {
				this.#queue.shift();
				this.#queuedBytes -= batch.bytes;
				this.#position = 0;
				continue;
			}
			const records = batch.records;
			while (this.#position < records.length && performance.now() < until) {
				try {
					this.#apply(records[this.#position++]);
				} catch (error) {
					this.#queue.length = 0;
					this.#queuedBytes = 0;
					this.#position = 0;
					logger.error(`Derived index '${this.id}' could not apply a record; requesting a rebuild`, error);
					this.#wake?.('failed');
					return;
				}
			}
			if (this.#position < records.length) break;
			this.#queue.shift();
			this.#queuedBytes -= batch.bytes;
			this.#position = 0;
			this.#appliedEpoch = batch.ownerEpoch;
			if (batch.through) this.#appliedCursor = batch.through;
		}
		if (this.#queue.length > 0) {
			this.#schedule();
			if (wasFull && this.#queuedBytes < QUEUE_CAPACITY_BYTES) this.#wake?.('changed');
			return;
		}
		if (wasFull) this.#wake?.('changed');
		if (this.#flushRequested) this.#runFlush();
	}

	#apply(mutation: DerivedIndexMutation) {
		const { recordId, logVersion, state } = mutation;
		if (state.kind !== 'record' || state.projection == null) {
			this.#index.applyDerivedValue(recordId, undefined, logVersion);
			return;
		}
		try {
			this.#index.applyDerivedValue(recordId, state.projection as number[], state.version);
		} catch (error) {
			// The projection validated the vector, but the plane's dimensionality is only known to the
			// worker holding it: a mismatch is this record's fault, not the index's. Same rule as the
			// runtime's own 4xx handling — remove any entry and count it, never rebuild.
			if (!(error instanceof ClientError)) throw error;
			if (this.#unindexable++ === 0)
				logger.warn?.(`Derived index '${this.id}' skipped a record its plane cannot hold: ${error.message}`);
			this.#index.applyDerivedValue(recordId, undefined, state.version);
		}
	}

	#runFlush() {
		if (this.#flushing) return;
		this.#flushRequested = false;
		const cursor = this.#appliedCursor;
		const epoch = this.#appliedEpoch;
		const host = this.#host!;
		this.#flushing = (async () => {
			await this.#index.flushDerived();
			if (epoch !== undefined && !host.isOwnerEpoch(epoch)) return;
			if (cursor) this.#index.indexStore.putSync(DERIVED_INDEX_CURSOR_KEY, cursor);
		})();
		this.#flushing.then(
			() => {
				this.#flushing = undefined;
				this.#wake?.('changed');
				if (this.#queue.length > 0) this.#schedule();
				else if (this.#flushRequested) this.#runFlush();
			},
			(error) => {
				this.#flushing = undefined;
				logger.error(`Derived index '${this.id}' durability barrier failed`, error);
				this.#wake?.('failed');
			}
		);
	}
}

type Registered = { runtime: DerivedIndexRuntime; tables: Map<number, { Table: any }> };
const runtimes = new WeakMap<object, Registered>();

function runtimeFor(auditStore: RocksTransactionLogStore): Registered {
	let registered = runtimes.get(auditStore);
	if (registered) return registered;
	const tables = new Map<number, { Table: any }>();
	const runtime = new DerivedIndexRuntime(
		auditStore,
		(tableId, recordId) => {
			const entry = tables.get(tableId)?.Table.primaryStore.getEntry(recordId);
			return entry?.value == null ? undefined : { version: entry.version, value: entry.value };
		},
		{
			scanRecords: (tableId) =>
				tables
					.get(tableId)!
					.Table.primaryStore.getRange({ versions: true, snapshot: false })
					.map(({ key, value, version }) => ({ recordId: key, version, value })),
		}
	);
	registered = { runtime, tables };
	runtimes.set(auditStore, registered);
	return registered;
}

const warnedAuditIndexes = new Set<string>();

/**
 * Register every post-commit custom index of a table with the shared derived-index runtime of its
 * database. Returns the release for the table's registrations, or undefined when it has none. Runs
 * on every worker; the runtime elects one owner per index.
 */
export function attachDerivedIndexes(Table: any): { close(): Promise<void> } | undefined {
	const attributes = Table.attributes.filter(
		(attribute: any) => Table.indices[attribute.name]?.customIndex?.postCommit
	);
	if (attributes.length === 0) return;
	if (Table.audit !== true) {
		throw new ClientError(
			`Table '${Table.databaseName}.${Table.tableName}' must enable audit logging before using a post-commit derived index`
		);
	}
	const auditStore = Table.auditStore as RocksTransactionLogStore;
	const registered = runtimeFor(auditStore);
	// A redefinition registers the same class again before the previous registration's release has
	// settled, so the release must only remove what it installed, not whatever is current.
	const installed = { Table };
	registered.tables.set(Table.tableId, installed);
	const releases: Array<() => Promise<void>> = [];
	for (const attribute of attributes) {
		const indexStore = Table.indices[attribute.name];
		const index = indexStore.customIndex as DerivedNativeIndex & { postCommit: true };
		const id = `hnsw:${indexStore.name}`;
		const warningKey = `${Table.databaseName}.${Table.tableName}.${indexStore.name}`;
		if (!warnedAuditIndexes.has(warningKey)) {
			warnedAuditIndexes.add(warningKey);
			logger.warn?.(
				`Derived index ${indexStore.name} requires auditing; the audit API retains full record history for the configured retention window`
			);
		}
		const resolver = Table.propertyResolvers?.[attribute.name];
		const label = `Vector for attribute "${attribute.name}"`;
		index.attachDerivedHost({
			readiness: () => registered.runtime.getReadiness(id),
			requestRebuild: () => registered.runtime.requestRebuild(id),
		});
		releases.push(
			registered.runtime.register({
				backend: new HnswDerivedIndexBackend(id, index),
				projections: new Map([
					[
						Table.tableId,
						(record: any) => {
							const vector = resolver ? resolver(record) : record[attribute.name];
							if (vector == null) return undefined;
							index.assertDerivedValue(vector, label);
							return vector;
						},
					],
				]),
				options: { maxLagMilliseconds: attribute.indexed?.maxLagMilliseconds ?? DEFAULT_MAX_LAG_MILLISECONDS },
			})
		);
	}
	return {
		async close() {
			await Promise.all(releases.map((release) => release()));
			if (registered.tables.get(Table.tableId) === installed) registered.tables.delete(Table.tableId);
		},
	};
}

/** Shared readiness of an index on any worker, registered or not. */
export function derivedIndexReadiness(auditStore: RocksTransactionLogStore, indexStoreName: string) {
	return readDerivedIndexReadiness(auditStore, `hnsw:${indexStoreName}`);
}
