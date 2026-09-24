import { ClientError } from '../../utility/errors/hdbError.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import type { Id } from '../ResourceInterface.ts';
import type { RocksTransactionLogStore } from '../RocksTransactionLogStore.ts';
import {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	readDerivedIndexReadiness,
	sameDerivedIndexPositions,
	type DerivedIndexBackend,
	type DerivedIndexBackendHost,
	type DerivedIndexBackendStateChange,
	type DerivedIndexBatch,
	type DerivedIndexCursor,
	type DerivedIndexCoverage,
	type DerivedIndexPositions,
	type DerivedIndexDeliveryResult,
	type DerivedIndexFlushReason,
	type DerivedIndexMutation,
	type DerivedIndexReadiness,
} from '../derivedIndexRuntime.ts';

const logger = loggerWithTag('HNSW');

/** The one durable cursor vector of a file-primary HNSW index, stored beside its node mappings. */
export const DERIVED_INDEX_CURSOR_KEY = Symbol.for('derived-index-cursor');
export const DEFAULT_MAX_INDEX_LAG_MILLISECONDS = 3000;
export const MAX_WAIT_FOR_INDEX_MILLISECONDS = 30_000;

export type DerivedNativeIndexHost = {
	readiness: () => DerivedIndexReadiness;
	coverage: (maxLagMilliseconds: number) => DerivedIndexCoverage;
	waitForCoverage: (since: bigint, timeout: number, signal?: AbortSignal) => Promise<void>;
	requestRebuild: () => boolean;
};

// Bounds on the queue between the runtime's delivery and the native applier. The runtime already
// chunks a delivery by records and estimated bytes; this caps how many chunks may wait.
const QUEUE_CAPACITY_BYTES = 64 * 1024 * 1024;
const APPLY_SLICE_MILLIS = 5;
const BARRIER_IDLE_MULTIPLE = 3;
const BARRIER_IDLE_CEILING_MILLISECONDS = 7_500;
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
	attachDerivedHost(host: DerivedNativeIndexHost): void;
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
	#interruptBarrierAfter = 0;
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

	publishCoverage(positions: DerivedIndexPositions, ownerEpoch: bigint): void {
		if (!this.#host?.isOwnerEpoch(ownerEpoch)) return;
		const cursor = this.getDurableCursor();
		if (!cursor) throw new Error('Cannot publish native index coverage without a durable cursor');
		if (cursor.coverage && sameDerivedIndexPositions(cursor.coverage, positions)) return;
		this.#index.indexStore.putSync(DERIVED_INDEX_CURSOR_KEY, { ...cursor, coverage: positions });
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
		await Promise.allSettled([this.#flushing, this.#resetting]);
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
		let advancedCursor = false;
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
			if (batch.through) {
				this.#appliedCursor = batch.through;
				advancedCursor = true;
				if (this.#mayInterruptForBarrier()) break;
			}
		}
		if (this.#queue.length > 0) {
			if (wasFull && this.#queuedBytes < QUEUE_CAPACITY_BYTES) this.#wake?.('changed');
			if (this.#position === 0 && advancedCursor && this.#mayInterruptForBarrier()) this.#runFlush(true);
			else this.#schedule();
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

	#mayInterruptForBarrier(): boolean {
		return this.#flushRequested && performance.now() >= this.#interruptBarrierAfter;
	}

	#runFlush(interrupting = false) {
		if (this.#flushing) return;
		this.#flushRequested = false;
		const started = performance.now();
		const cursor = this.#appliedCursor;
		const epoch = this.#appliedEpoch;
		const host = this.#host!;
		this.#flushing = (async () => {
			await this.#index.flushDerived();
			if (epoch !== undefined && !host.isOwnerEpoch(epoch)) return;
			if (cursor) {
				const coverage = this.getDurableCursor()?.coverage;
				this.#index.indexStore.putSync(DERIVED_INDEX_CURSOR_KEY, coverage ? { ...cursor, coverage } : cursor);
			}
		})();
		this.#flushing.then(
			() => {
				this.#flushing = undefined;
				if (interrupting) {
					const idle = Math.min(
						BARRIER_IDLE_MULTIPLE * (performance.now() - started),
						BARRIER_IDLE_CEILING_MILLISECONDS
					);
					this.#interruptBarrierAfter = performance.now() + idle;
				}
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

/** Shared readiness of an index on any worker, registered or not. */
export function derivedIndexReadiness(auditStore: RocksTransactionLogStore, indexStoreName: string) {
	return readDerivedIndexReadiness(auditStore, `hnsw:${indexStoreName}`);
}
