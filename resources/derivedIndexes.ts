import { ClientError } from '../utility/errors/hdbError.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import type { RocksTransactionLogStore } from './RocksTransactionLogStore.ts';
import { DerivedIndexRuntime, readDerivedIndexCoverage } from './derivedIndexRuntime.ts';
import {
	DERIVED_INDEX_CURSOR_KEY,
	HnswDerivedIndexBackend,
	type DerivedNativeIndex,
} from './indexes/hnswDerivedIndex.ts';

const logger = loggerWithTag('HNSW');
// Writes to an index this far behind fail with a retryable 503 (see the runtime's lag policy).
const DEFAULT_MAX_LAG_MILLISECONDS = 30_000;

// One generation owns each physical backend; destructive cleanup also awaits superseded generations.
type RegisteredTable = { current: { Table: any }; owners: Set<{ Table: any }> };
type RegisteredBackend = {
	tableId: number;
	settle: () => Promise<void>;
};
type Registered = {
	runtime: DerivedIndexRuntime;
	tables: Map<number, RegisteredTable>;
	backends: Map<string, RegisteredBackend>;
	tableBackends: Map<number, Set<RegisteredBackend>>;
	droppingTables: Set<number>;
	retryUnavailable: Set<string>;
};
const runtimes = new WeakMap<object, Registered>();
const retryUnavailableByStore = new Set<string>();

function retryUnavailableKey(auditStore: RocksTransactionLogStore, backendId: string): string {
	return `${auditStore.rootStore.path}\0${backendId}`;
}

function markUnavailableRetry(registered: Registered, auditStore: RocksTransactionLogStore, backendId: string): void {
	registered.retryUnavailable.add(backendId);
	retryUnavailableByStore.add(retryUnavailableKey(auditStore, backendId));
}

function consumeUnavailableRetry(
	registered: Registered,
	auditStore: RocksTransactionLogStore,
	backendId: string
): boolean {
	const local = registered.retryUnavailable.delete(backendId);
	const storeScoped = retryUnavailableByStore.delete(retryUnavailableKey(auditStore, backendId));
	return local || storeScoped;
}

function runtimeFor(auditStore: RocksTransactionLogStore): Registered {
	let registered = runtimes.get(auditStore);
	if (registered) return registered;
	const tables = new Map<number, RegisteredTable>();
	const runtime = new DerivedIndexRuntime(
		auditStore,
		(tableId, recordId) => {
			const entry = tables.get(tableId)?.current.Table.primaryStore.getEntry(recordId);
			return entry?.value == null ? undefined : { version: entry.version, value: entry.value };
		},
		{
			scanRecords: (tableId) =>
				tables
					.get(tableId)!
					.current.Table.primaryStore.getRange({ versions: true, snapshot: false })
					.map(({ key, value, version }) => ({ recordId: key, version, value })),
		}
	);
	registered = {
		runtime,
		tables,
		backends: new Map(),
		tableBackends: new Map(),
		droppingTables: new Set(),
		retryUnavailable: new Set(),
	};
	runtimes.set(auditStore, registered);
	return registered;
}

const warnedAuditIndexes = new Set<string>();

/**
 * Register every post-commit custom index of a table with the shared derived-index runtime of its
 * database. Returns the release for the table's registrations, or undefined when it has none. Runs
 * on every worker; the runtime elects one owner per index.
 */
export function attachDerivedIndexes(Table: any):
	| {
			close(dropping?: boolean): Promise<void>;
			restoreAfterFailedDrop(): ReturnType<typeof attachDerivedIndexes>;
			completeDrop(dropped?: boolean): void;
	  }
	| undefined {
	const hnswAttributes = Table.attributes.filter(
		(attribute: any) => attribute.indexed?.type === 'HNSW' && Table.indices[attribute.name]?.customIndex
	);
	const attributes = hnswAttributes.filter((attribute: any) => Table.indices[attribute.name]?.customIndex?.postCommit);
	if (Table.audit !== true && attributes.length > 0) {
		throw new ClientError(
			`Table '${Table.databaseName}.${Table.tableName}' must enable audit logging before using a post-commit derived index`
		);
	}
	if (!Table.auditStore) return;
	const auditStore = Table.auditStore as RocksTransactionLogStore;
	const registered = runtimeFor(auditStore);
	if (registered.droppingTables.has(Table.tableId)) return;
	for (const attribute of hnswAttributes) {
		const indexStore = Table.indices[attribute.name];
		const id = `hnsw:${indexStore.name}`;
		// A transient JS-backed declaration can precede the first native registration while a
		// schema is being installed. Only an explicit transition away from an already-registered
		// native backend should make a later native registration eligible to rearm an exhausted
		// rebuild budget.
		if (attribute.indexed.nativePlane === false && !indexStore.customIndex.postCommit && registered.backends.has(id))
			markUnavailableRetry(registered, auditStore, id);
	}
	if (attributes.length === 0) return;
	const installed = { Table };
	let registeredTable = registered.tables.get(Table.tableId);
	if (registeredTable) {
		registeredTable.owners.add(installed);
		registeredTable.current = installed;
	} else {
		registeredTable = { current: installed, owners: new Set([installed]) };
		registered.tables.set(Table.tableId, registeredTable);
	}
	const releases: Array<() => Promise<void>> = [];
	const backendIds: string[] = [];
	const registeredBackends = new Map<string, RegisteredBackend>();
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
			coverage: (maxLagMilliseconds) =>
				readDerivedIndexCoverage(
					auditStore,
					id,
					() => indexStore.getSync(DERIVED_INDEX_CURSOR_KEY),
					maxLagMilliseconds
				),
			requestRebuild: () => registered.runtime.requestRebuild(id),
			waitForCoverage: (since, timeout, signal) => registered.runtime.waitForCoverage(id, since, timeout, signal),
		});
		let predecessor = registered.backends.get(id);
		const inherited = predecessor;
		const settlePredecessor = () => {
			const current = predecessor;
			if (!current) return Promise.resolve();
			const settled = current.settle();
			settled.then(
				() => {
					if (predecessor === current) predecessor = undefined;
				},
				() => {}
			);
			return settled;
		};
		const predecessorSettled = settlePredecessor();
		predecessorSettled.catch(() => {});
		if (registered.backends.get(id) === inherited) registered.backends.delete(id);
		const release = registered.runtime.register({
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
		});
		let settling: Promise<void> | undefined;
		const registeredBackend: RegisteredBackend = {
			tableId: Table.tableId,
			settle: () => {
				if (settling) return settling;
				const attempt = Promise.allSettled([settlePredecessor(), release()]).then((results) => {
					if (results[1].status === 'fulfilled') {
						if (registered.backends.get(id) === registeredBackend) registered.backends.delete(id);
						const tableBackends = registered.tableBackends.get(Table.tableId);
						tableBackends?.delete(registeredBackend);
						if (tableBackends?.size === 0) registered.tableBackends.delete(Table.tableId);
					}
					const failures = results
						.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
						.map((result) => result.reason);
					if (failures.length === 1) throw failures[0];
					if (failures.length) throw new AggregateError(failures, `Could not settle HNSW backend '${id}'`);
				});
				settling = attempt;
				attempt.catch(() => {
					if (settling === attempt) settling = undefined;
				});
				return attempt;
			},
		};
		let tableBackends = registered.tableBackends.get(Table.tableId);
		if (!tableBackends) registered.tableBackends.set(Table.tableId, (tableBackends = new Set()));
		tableBackends.add(registeredBackend);
		registered.backends.set(id, registeredBackend);
		registeredBackends.set(id, registeredBackend);
		const retryUnavailable = consumeUnavailableRetry(registered, auditStore, id);
		if (retryUnavailable && registered.runtime.getReadiness(id).state === 'unavailable')
			registered.runtime.requestRebuild(id);
		backendIds.push(id);
		releases.push(() => registeredBackend.settle());
	}
	return {
		async close(dropping = false) {
			if (dropping) registered.droppingTables.add(Table.tableId);
			const settlements = dropping
				? [...(registered.tableBackends.get(Table.tableId) ?? [])].map((backend) => backend.settle())
				: releases.map((release) => release());
			const tableRegistration = registered.tables.get(Table.tableId);
			if (tableRegistration) {
				tableRegistration.owners.delete(installed);
				if (tableRegistration.owners.size === 0) {
					registered.tables.delete(Table.tableId);
				} else if (tableRegistration.current === installed) {
					tableRegistration.current = tableRegistration.owners.values().next().value;
				}
			}
			if (dropping) {
				await Promise.all(settlements);
			} else {
				for (const result of await Promise.allSettled(settlements)) {
					if (result.status === 'rejected')
						logger.error(`Could not settle a superseded HNSW backend for table ${Table.tableId}`, result.reason);
				}
			}
		},
		restoreAfterFailedDrop() {
			registered.droppingTables.delete(Table.tableId);
			for (const [id, registeredBackend] of registeredBackends) {
				const current = registered.backends.get(id);
				if (current && current !== registeredBackend) return;
			}
			return attachDerivedIndexes(Table);
		},
		completeDrop(dropped = true) {
			registered.droppingTables.delete(Table.tableId);
			if (dropped) for (const id of backendIds) markUnavailableRetry(registered, auditStore, id);
		},
	};
}
