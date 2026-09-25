import { ClientError } from '../utility/errors/hdbError.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import type { RocksTransactionLogStore } from './RocksTransactionLogStore.ts';
import {
	acquireFullTextRetirementFence,
	registerDerivedIndexTables,
	waitForFullTextRetirement,
	waitForFullTextRetirementLease,
} from './derivedIndexRegistry.ts';
import {
	DerivedIndexRuntime,
	publishDerivedIndexReadiness,
	publishDerivedIndexUnavailableIfUnknown,
	readDerivedIndexCoverage,
	readDerivedIndexReadiness,
	retryDerivedIndexUnavailable,
} from './derivedIndexRuntime.ts';
import {
	DERIVED_INDEX_CURSOR_KEY,
	HnswDerivedIndexBackend,
	type DerivedNativeIndex,
} from './indexes/hnswDerivedIndex.ts';
import {
	createNativeFullTextDerivedIndexBackend,
	retireNativeFullTextDerivedIndexStorage,
} from './indexes/nativeFullTextDerivedIndexLifecycle.ts';
import type { NativeFullTextModule } from './indexes/fullTextNativeBinding.ts';
import { fullTextStorageDefinition, type FullTextDefinition } from './fullTextSchema.ts';

const logger = loggerWithTag('HNSW');
const fullTextLogger = loggerWithTag('fulltext-derived-index');
const derivedIndexLogger = loggerWithTag('derived-index');
const DEFAULT_MAX_LAG_MILLISECONDS = 30_000;
const DEFAULT_FULL_TEXT_RETIREMENT_RETRY_MILLISECONDS = 70_000;
const FULL_TEXT_LIMITS = Object.freeze({
	indexingThreads: 1,
	searchThreads: 1,
	writerMemoryBytes: 32 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
});

// One generation owns each physical backend; destructive cleanup also awaits superseded generations.
type RegisteredTable = { current: { Table: any }; owners: Set<{ Table: any }> };
type RegisteredBackend = {
	settle: () => Promise<void>;
};
type BackendHandoff = {
	settlePredecessor: () => Promise<void>;
	predecessorSettled: Promise<void>;
};
type Registered = {
	runtime: DerivedIndexRuntime;
	tables: Map<number, RegisteredTable>;
	backends: Map<string, RegisteredBackend>;
	tableBackends: Map<number, Set<RegisteredBackend>>;
	droppingTables: Set<number>;
	retryUnavailable: Set<string>;
};
type DerivedIndexAttachment = {
	close(dropping?: boolean): Promise<void>;
	fullTextDefinitions(): readonly FullTextDefinition[];
	matchesCurrent(): boolean;
	retryUnavailableFullText(): void;
	restoreAfterFailedDrop(): DerivedIndexAttachment | undefined;
	retireAfterConfirmedDrop(definitions?: readonly Pick<FullTextDefinition, 'name'>[]): Promise<boolean>;
	completeDrop(dropped?: boolean): void;
};
type FullTextTestConfiguration = {
	binding: NativeFullTextModule;
	closeTimeoutMilliseconds: number;
	shutdownTimeoutMilliseconds: number;
	runnerOptions: {
		rebuildBackoffMilliseconds: number;
		maxRebuildBackoffMilliseconds: number;
		maxRebuildAttempts: number;
		lockRetryMilliseconds: number;
	};
};
const runtimes = new WeakMap<object, Registered>();
const suspendedActivation = new WeakMap<object, number>();
const PERMANENTLY_SUSPENDED = -1;
const retryUnavailableByStore = new WeakMap<object, Set<string>>();
let fullTextTestConfiguration: FullTextTestConfiguration | undefined;

/** Prevent new derived-index attachments while a root store is being torn down. */
export function suspendDerivedIndexActivation(rootStore: object): () => void {
	const current = suspendedActivation.get(rootStore) ?? 0;
	if (current !== PERMANENTLY_SUSPENDED) suspendedActivation.set(rootStore, current + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = suspendedActivation.get(rootStore);
		if (current === PERMANENTLY_SUSPENDED) return;
		const remaining = (current ?? 1) - 1;
		if (remaining > 0) suspendedActivation.set(rootStore, remaining);
		else suspendedActivation.delete(rootStore);
	};
}

/** Prevent abandoned root wrappers from reattaching derived indexes after a failed native close. */
export function permanentlySuspendDerivedIndexActivation(rootStore: object): void {
	suspendedActivation.set(rootStore, PERMANENTLY_SUSPENDED);
}

function activationSuspended(Table: any): boolean {
	const rootStore = Table.primaryStore?.rootStore;
	// Closed roots no longer retain an active suspension count, but stale table classes must not
	// resurrect their derived-index runtime after successful teardown.
	return rootStore != null && (rootStore.status === 'closed' || suspendedActivation.has(rootStore));
}

function markUnavailableRetry(registered: Registered, auditStore: RocksTransactionLogStore, backendId: string): void {
	registered.retryUnavailable.add(backendId);
	const rootStore = auditStore.rootStore;
	let retries = retryUnavailableByStore.get(rootStore);
	if (!retries) retryUnavailableByStore.set(rootStore, (retries = new Set()));
	retries.add(backendId);
}

function consumeUnavailableRetry(
	registered: Registered,
	auditStore: RocksTransactionLogStore,
	backendId: string
): boolean {
	const local = registered.retryUnavailable.delete(backendId);
	const rootStore = auditStore.rootStore;
	const retries = retryUnavailableByStore.get(rootStore);
	const storeScoped = retries?.delete(backendId) ?? false;
	if (retries?.size === 0) retryUnavailableByStore.delete(rootStore);
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
			return entry?.value == null ? undefined : { version: entry.version, value: entry.value, size: entry.size };
		},
		{
			scanRecords: (tableId) => {
				const Table = tables.get(tableId)?.current.Table;
				if (!Table) throw new Error(`Derived-index table ${tableId} is no longer registered`);
				return Table.primaryStore
					.getRange({ versions: true, snapshot: false })
					.map(({ key, value, version, size }) => ({ recordId: key, version, value, size }));
			},
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

function beginBackendHandoff(registered: Registered, id: string): BackendHandoff {
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
	return { settlePredecessor, predecessorSettled };
}

function registerBackend(
	registered: Registered,
	tableId: number,
	id: string,
	label: string,
	settlePredecessor: () => Promise<void>,
	settleCurrent: () => Promise<unknown>
): RegisteredBackend {
	let settling: Promise<void> | undefined;
	const registeredBackend: RegisteredBackend = {
		settle: () => {
			if (settling) return settling;
			const attempt = Promise.allSettled([settlePredecessor(), settleCurrent()]).then((results) => {
				if (results.every((result) => result.status === 'fulfilled')) {
					if (registered.backends.get(id) === registeredBackend) registered.backends.delete(id);
					const tableBackends = registered.tableBackends.get(tableId);
					tableBackends?.delete(registeredBackend);
					if (tableBackends?.size === 0) registered.tableBackends.delete(tableId);
				}
				const failures = results
					.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
					.map((result) => result.reason);
				if (failures.length === 1) throw failures[0];
				if (failures.length) throw new AggregateError(failures, `Could not settle ${label} backend '${id}'`);
			});
			const retryable = attempt.catch((error) => {
				if (settling === retryable) settling = undefined;
				throw error;
			});
			settling = retryable;
			return retryable;
		},
	};
	let tableBackends = registered.tableBackends.get(tableId);
	if (!tableBackends) registered.tableBackends.set(tableId, (tableBackends = new Set()));
	tableBackends.add(registeredBackend);
	registered.backends.set(id, registeredBackend);
	return registeredBackend;
}

const warnedAuditIndexes = new Set<string>();

/**
 * Register every post-commit custom index of a table with the shared derived-index runtime of its
 * database. Returns the release for the table's registrations, or undefined when it has none. Runs
 * on every worker; the runtime elects one owner per index.
 */
export function attachDerivedIndexes(
	Table: any,
	options: { retryUnavailableReadiness?: boolean } = {}
): DerivedIndexAttachment | undefined {
	if (activationSuspended(Table)) return;
	const hnswAttributes = Table.attributes.filter(
		(attribute: any) => attribute.indexed?.type === 'HNSW' && Table.indices[attribute.name]?.customIndex
	);
	const attributes = hnswAttributes.filter((attribute: any) => Table.indices[attribute.name]?.customIndex?.postCommit);
	const fullTextDefinitions = (Table.fullTextIndexes ?? []) as FullTextDefinition[];
	const fullTextRetirementNames =
		Table.primaryStore?.rootStore instanceof RocksDatabase
			? [...new Set((Table.fullTextIndexRetirements ?? []) as string[])].sort()
			: [];
	if (Table.audit !== true && (attributes.length > 0 || fullTextDefinitions.length > 0)) {
		throw new ClientError(
			`Table '${Table.databaseName}.${Table.tableName}' must enable audit logging before using a post-commit derived index`
		);
	}
	assertFullTextActivationSupported(
		Table.primaryStore?.rootStore,
		Table.databaseName,
		Table.tableName,
		fullTextDefinitions
	);
	if (!Table.auditStore) {
		if (fullTextRetirementNames.length > 0) return attachFullTextRetirementRecovery(Table, fullTextRetirementNames);
		return;
	}
	const auditStore = Table.auditStore as RocksTransactionLogStore;
	const registered = runtimeFor(auditStore);
	const fullTextTest = fullTextTestConfiguration;
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
	if (attributes.length === 0 && fullTextDefinitions.length === 0 && fullTextRetirementNames.length === 0) return;
	if (
		attributes.length === 0 &&
		fullTextDefinitions.length === 0 &&
		(registered.tableBackends.get(Table.tableId)?.size ?? 0) > 0
	)
		return;
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
	const hnswRetryBackendIds: string[] = [];
	const registeredBackends = new Map<string, RegisteredBackend>();
	const fullTextSetups = new Map<string, Promise<void>>();
	let closing = false;
	let registrationReleased = false;
	let closeOperation: Promise<void> | undefined;
	const fullTextSnapshot = fullTextActivationSnapshot(Table, fullTextDefinitions);
	let fullTextRetirementSnapshot = JSON.stringify(fullTextRetirementNames);
	let fullTextRetirementRecoveryFailed = false;
	const persistedRetirementOperation = resumePersistedFullTextRetirements(
		Table,
		fullTextRetirementNames,
		() => !closing && registered.tables.get(Table.tableId)?.current === installed
	);
	const persistedRetirementSettlement = persistedRetirementOperation.then(
		(completed) => {
			if (completed) fullTextRetirementSnapshot = JSON.stringify(Table.fullTextIndexRetirements ?? []);
			else fullTextRetirementRecoveryFailed = true;
		},
		(error) => {
			fullTextRetirementRecoveryFailed = true;
			fullTextLogger.warn?.(
				`Could not resume full-text retirement for ${Table.databaseName}.${Table.tableName}`,
				error
			);
		}
	);
	const hnswSnapshot = attributes.map((attribute: any) => ({
		name: attribute.name,
		index: Table.indices[attribute.name]?.customIndex,
		computedFrom: attribute.computed?.from,
		computedFromExpression: attribute.computedFromExpression,
		userResolver:
			attribute.computed && !attribute.computedFromExpression ? Table.userResolvers?.[attribute.name] : undefined,
	}));
	const releaseFullTextRegistration =
		fullTextDefinitions.length > 0 ? registerDerivedIndexTables(auditStore, [Table.tableId]) : undefined;
	const releaseRegistration = () => {
		if (registrationReleased) return;
		registrationReleased = true;
		releaseFullTextRegistration?.();
	};
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
		const { settlePredecessor } = beginBackendHandoff(registered, id);
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
		const registeredBackend = registerBackend(registered, Table.tableId, id, 'HNSW', settlePredecessor, release);
		registeredBackends.set(id, registeredBackend);
		const retryUnavailable = consumeUnavailableRetry(registered, auditStore, id);
		if (retryUnavailable && registered.runtime.getReadiness(id).state === 'unavailable')
			registered.runtime.requestRebuild(id);
		hnswRetryBackendIds.push(id);
		releases.push(() => registeredBackend.settle());
	}
	for (const definition of fullTextDefinitions) startFullTextBackend(definition, options.retryUnavailableReadiness);

	function startFullTextBackend(definition: FullTextDefinition, retryUnavailableReadiness = false): void {
		if (fullTextSetups.has(definition.name)) return;
		const generation = Table.fullTextIndexGenerations?.[definition.name];
		const id = fullTextDerivedIndexId(Table, definition.name);
		const readinessId = fullTextDerivedIndexReadinessId(Table, definition.name, generation);
		if (typeof generation !== 'string' || generation.length === 0) {
			publishDerivedIndexReadiness(auditStore, readinessId, 'unavailable', 'backend-failed');
			fullTextLogger.error?.(
				`Full-text index ${Table.databaseName}.${Table.tableName}.${definition.name} has no durable generation; reapply its schema to activate it`
			);
			return;
		}

		const { settlePredecessor, predecessorSettled } = beginBackendHandoff(registered, id);
		const quiescePredecessor = async () => {
			try {
				await predecessorSettled;
			} catch (error) {
				if (!registered.runtime.requestRebuild(id)) throw error;
				await settlePredecessor();
			}
		};
		let cancelled = false;
		let release: (() => Promise<void>) | undefined;
		let setup: Promise<void>;
		const registeredBackend = registerBackend(registered, Table.tableId, id, 'full-text', settlePredecessor, () => {
			cancelled = true;
			return setup.then(() => release?.());
		});
		registeredBackends.set(id, registeredBackend);
		releases.push(() => registeredBackend.settle());

		const isCurrent = () =>
			!closing &&
			!cancelled &&
			registered.tables.get(Table.tableId)?.current === installed &&
			Table.fullTextIndexGenerations?.[definition.name] === generation;
		setup = (async () => {
			await quiescePredecessor();
			if (!isCurrent()) return;
			if (
				!(await waitForFullTextRetirement(Table.primaryStore.rootStore, Table.tableName, {
					shouldContinue: isCurrent,
				}))
			)
				return;
			if (!isCurrent()) return;
			if (retryUnavailableReadiness) retryDerivedIndexUnavailable(auditStore, readinessId);
			const storage = fullTextStorageDefinition(definition);
			const storeName = `${Table.tableName}/${definition.name}`;
			const warningKey = `${Table.primaryStore.rootStore.path}:${storeName}`;
			if (!warnedAuditIndexes.has(warningKey)) {
				warnedAuditIndexes.add(warningKey);
				fullTextLogger.warn?.(
					`Derived index ${storeName} requires auditing; the audit API retains full record history for the configured retention window`
				);
			}
			const backend = await createNativeFullTextDerivedIndexBackend({
				id,
				storePath: Table.primaryStore.rootStore.path,
				storeName,
				sourceGeneration: `${Table.tableId}:${generation}`,
				fields: storage.fields,
				analyzer: storage.analyzer,
				stopWords: storage.stopWords,
				positions: storage.positions,
				surfaceTerms: storage.surfaceTerms,
				limits: { ...FULL_TEXT_LIMITS },
				...(fullTextTest
					? {
							binding: fullTextTest.binding,
							closeTimeoutMilliseconds: fullTextTest.closeTimeoutMilliseconds,
							shutdownTimeoutMilliseconds: fullTextTest.shutdownTimeoutMilliseconds,
						}
					: {}),
			});
			if (!isCurrent()) return;
			release = registered.runtime.register({
				backend,
				readinessId,
				isCurrent,
				projections: new Map([[Table.tableId, fullTextProjection(definition)]]),
				options: {
					maxLagMilliseconds: DEFAULT_MAX_LAG_MILLISECONDS,
					...fullTextTest?.runnerOptions,
				},
			});
		})().catch((error) => {
			if (!isCurrent()) return;
			// Setup runs on every worker, but readiness is shared. A local setup failure must not
			// replace a state already published by the elected runner on another worker.
			publishDerivedIndexUnavailableIfUnknown(auditStore, readinessId);
			fullTextLogger.error?.(
				`Could not activate full-text index ${Table.databaseName}.${Table.tableName}.${definition.name}`,
				error
			);
		});
		fullTextSetups.set(definition.name, setup);
		void setup.finally(() => {
			if (fullTextSetups.get(definition.name) === setup) fullTextSetups.delete(definition.name);
		});
	}
	return {
		fullTextDefinitions() {
			return fullTextDefinitions;
		},
		async close(dropping = false) {
			if (dropping) registered.droppingTables.add(Table.tableId);
			if (closeOperation) return closeOperation;
			closing = true;
			const settlements = dropping
				? [...(registered.tableBackends.get(Table.tableId) ?? [])].map((backend) => backend.settle())
				: releases.map((release) => release());
			const retained = new Set(
				((Table.fullTextIndexes ?? []) as FullTextDefinition[]).map((definition) => definition.name)
			);
			const removedDefinitions = dropping
				? []
				: fullTextDefinitions.filter((definition) => !retained.has(definition.name));
			let releaseRetirementFence: (() => void) | undefined;
			let waitForPeerRetirement: Promise<boolean> | undefined;
			if (removedDefinitions.length > 0) {
				releaseRetirementFence = acquireFullTextRetirementFence(Table.primaryStore.rootStore, Table.tableName);
				if (!releaseRetirementFence)
					waitForPeerRetirement = waitForFullTextRetirement(Table.primaryStore.rootStore, Table.tableName, {
						shouldContinue: () => Table.primaryStore.rootStore.status === 'open',
					});
			}
			const tableRegistration = registered.tables.get(Table.tableId);
			if (tableRegistration) {
				tableRegistration.owners.delete(installed);
				if (tableRegistration.owners.size === 0) {
					registered.tables.delete(Table.tableId);
				} else if (tableRegistration.current === installed) {
					tableRegistration.current = tableRegistration.owners.values().next().value;
				}
			}
			const operation = (async () => {
				try {
					if (dropping) await Promise.all(settlements);
					else {
						const results = await Promise.allSettled(settlements);
						const failures: unknown[] = [];
						for (const result of results) {
							if (result.status === 'rejected') {
								failures.push(result.reason);
								derivedIndexLogger.error(
									`Could not settle a superseded derived-index backend for table ${Table.tableId}`,
									result.reason
								);
							}
						}
						if (failures.length === 1) throw failures[0];
						if (failures.length)
							throw new AggregateError(failures, `Could not settle derived indexes for table ${Table.tableId}`);
						if (releaseRetirementFence) {
							const retired = await retireFullTextIndexes(Table, removedDefinitions);
							if (retired) await Table.completeFullTextIndexRetirements?.(removedDefinitions.map(({ name }) => name));
						} else if (waitForPeerRetirement) await waitForPeerRetirement;
						await persistedRetirementSettlement;
						releaseRegistration();
					}
				} finally {
					releaseRetirementFence?.();
				}
			})();
			const retryable = operation.catch((error) => {
				if (closeOperation === retryable) closeOperation = undefined;
				throw error;
			});
			closeOperation = retryable;
			return closeOperation;
		},
		matchesCurrent() {
			if (closing || fullTextRetirementRecoveryFailed || !matchesCurrentHnsw()) return false;
			const currentDefinitions = (Table.fullTextIndexes ?? []) as FullTextDefinition[];
			return (
				fullTextActivationSnapshot(Table, currentDefinitions) === fullTextSnapshot &&
				JSON.stringify(Table.fullTextIndexRetirements ?? []) === fullTextRetirementSnapshot
			);
		},
		retryUnavailableFullText() {
			if (closing) return;
			for (const definition of fullTextDefinitions) {
				const generation = Table.fullTextIndexGenerations?.[definition.name];
				if (
					readDerivedIndexReadiness(auditStore, fullTextDerivedIndexReadinessId(Table, definition.name, generation))
						.state === 'unavailable'
				)
					startFullTextBackend(definition, true);
			}
		},
		restoreAfterFailedDrop() {
			registered.droppingTables.delete(Table.tableId);
			const currentTable = registered.tables.get(Table.tableId)?.current.Table;
			if (currentTable && currentTable !== Table) {
				releaseRegistration();
				return;
			}
			for (const registration of registered.tables.values()) {
				const current = registration.current.Table;
				if (current !== Table && current.databasePath === Table.databasePath && current.tableName === Table.tableName) {
					releaseRegistration();
					return;
				}
			}
			for (const [id, registeredBackend] of registeredBackends) {
				const current = registered.backends.get(id);
				if (current && current !== registeredBackend) {
					releaseRegistration();
					return;
				}
			}
			const restored = attachDerivedIndexes(Table, { retryUnavailableReadiness: true });
			if (restored) releaseRegistration();
			return restored;
		},
		retireAfterConfirmedDrop(definitions = fullTextDefinitions) {
			return retireFullTextIndexes(Table, definitions);
		},
		completeDrop(dropped = true) {
			releaseRegistration();
			registered.droppingTables.delete(Table.tableId);
			if (dropped) for (const id of hnswRetryBackendIds) markUnavailableRetry(registered, auditStore, id);
		},
	};

	function matchesCurrentHnsw(): boolean {
		const current = Table.attributes.filter(
			(attribute: any) => attribute.indexed?.type === 'HNSW' && Table.indices[attribute.name]?.customIndex?.postCommit
		);
		if (current.length !== hnswSnapshot.length) return false;
		return hnswSnapshot.every(({ name, index, computedFrom, computedFromExpression, userResolver }) => {
			const indexStore = Table.indices[name];
			const attribute = current.find((candidate: any) => candidate.name === name);
			return (
				indexStore?.customIndex === index &&
				Object.is(attribute?.computed?.from, computedFrom) &&
				attribute?.computedFromExpression === computedFromExpression &&
				(attribute?.computed && !attribute.computedFromExpression ? Table.userResolvers?.[name] : undefined) ===
					userResolver
			);
		});
	}
}

/** Retire durable native indexes even when their in-memory attachment could not be restored. */
export async function retireFullTextIndexes(
	Table: any,
	definitions: readonly Pick<FullTextDefinition, 'name'>[],
	shouldContinue: () => boolean = () => true
): Promise<boolean> {
	const fullTextTest = fullTextTestConfiguration;
	const retryMilliseconds =
		fullTextTest?.shutdownTimeoutMilliseconds ?? DEFAULT_FULL_TEXT_RETIREMENT_RETRY_MILLISECONDS;
	const deadline = Date.now() + retryMilliseconds;
	let retired = true;
	for (const definition of definitions) {
		if (!shouldContinue()) return false;
		let retryDelayMilliseconds = 10;
		let retrying = false;
		for (;;) {
			try {
				await retireNativeFullTextDerivedIndexStorage({
					storePath: Table.primaryStore.rootStore.path,
					storeName: `${Table.tableName}/${definition.name}`,
					indexId: fullTextDerivedIndexId(Table, definition.name),
					...(fullTextTest ? { binding: fullTextTest.binding } : {}),
				});
				break;
			} catch (error) {
				if (!shouldContinue()) return false;
				const code =
					error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
						? error.code
						: undefined;
				const remaining = deadline - Date.now();
				if (code === 'E_LOCK_BUSY' && remaining > 0) {
					if (!retrying) {
						retrying = true;
						fullTextLogger.warn?.(
							`Waiting up to ${retryMilliseconds}ms to retire full-text index ${Table.databaseName}.${Table.tableName}.${definition.name}`
						);
					}
					await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMilliseconds, remaining)));
					if (!shouldContinue()) return false;
					retryDelayMilliseconds = Math.min(retryDelayMilliseconds * 2, 250);
					continue;
				}
				fullTextLogger.warn?.(
					`Could not retire full-text index ${Table.databaseName}.${Table.tableName}.${definition.name}`,
					error
				);
				retired = false;
				break;
			}
		}
	}
	return retired;
}

async function resumePersistedFullTextRetirements(
	Table: any,
	names: readonly string[],
	shouldContinue: () => boolean
): Promise<boolean> {
	if (names.length === 0) return true;
	const rootStore = Table.primaryStore.rootStore;
	const releaseRetirementFence = await waitForFullTextRetirementLease(rootStore, Table.tableName, {
		shouldContinue,
		timeoutMilliseconds: DEFAULT_FULL_TEXT_RETIREMENT_RETRY_MILLISECONDS,
	});
	if (!releaseRetirementFence) return false;
	try {
		if (!shouldContinue()) return false;
		if (!(await Table.hasCurrentFullTextIndexRetirements(names))) return true;
		const retired = await retireFullTextIndexes(
			Table,
			names.map((name) => ({ name })),
			shouldContinue
		);
		if (!retired || !shouldContinue()) return false;
		await Table.completeFullTextIndexRetirements?.(names);
		return true;
	} finally {
		releaseRetirementFence();
	}
}

function attachFullTextRetirementRecovery(Table: any, names: readonly string[]): DerivedIndexAttachment {
	let closing = false;
	let settled = false;
	const operation = resumePersistedFullTextRetirements(Table, names, () => !closing);
	const settlement = operation.then(
		() => {
			settled = true;
		},
		(error) => {
			settled = true;
			fullTextLogger.warn?.(
				`Could not resume full-text retirement for ${Table.databaseName}.${Table.tableName}`,
				error
			);
		}
	);
	return {
		async close() {
			closing = true;
			await settlement;
		},
		fullTextDefinitions() {
			return [];
		},
		matchesCurrent() {
			return !closing && !settled && JSON.stringify(Table.fullTextIndexRetirements ?? []) === JSON.stringify(names);
		},
		retryUnavailableFullText() {},
		restoreAfterFailedDrop() {
			return undefined;
		},
		retireAfterConfirmedDrop(definitions = names.map((name) => ({ name }))) {
			return retireFullTextIndexes(Table, definitions);
		},
		completeDrop() {},
	};
}

/** Keep a healthy, generation-identical full-text attachment across routine catalog reloads. */
export function refreshDerivedIndexes(Table: any): void {
	const current = Table.derivedIndexRuntime;
	if (activationSuspended(Table)) {
		const closing = current?.close();
		if (closing)
			void closing.then(
				() => {
					if (Table.derivedIndexRuntime === current) Table.derivedIndexRuntime = undefined;
				},
				(error) => {
					derivedIndexLogger.error(`Could not settle suspended derived indexes for table ${Table.tableId}`, error);
				}
			);
		return;
	}
	if (current?.matchesCurrent?.()) {
		current.retryUnavailableFullText?.();
		return;
	}
	let next: DerivedIndexAttachment | undefined;
	const closing = current?.close();
	if (closing)
		void closing.then(
			() => {
				if (!next && Table.derivedIndexRuntime === current) Table.derivedIndexRuntime = undefined;
			},
			(error) => {
				derivedIndexLogger.error(`Could not settle replaced derived indexes for table ${Table.tableId}`, error);
			}
		);
	next = attachDerivedIndexes(Table, {
		retryUnavailableReadiness: Boolean(current),
	});
	Table.derivedIndexRuntime = next ?? current;
}

export function assertFullTextActivationSupported(
	rootStore: unknown,
	databaseName: string,
	tableName: string,
	definitions: readonly FullTextDefinition[]
): void {
	if (definitions.length > 0 && !(rootStore instanceof RocksDatabase))
		throw new ClientError(
			`Table '${databaseName}.${tableName}' cannot activate @fullText with the LMDB storage engine`,
			400
		);
}

function fullTextProjection(definition: FullTextDefinition) {
	return (record: Record<string, unknown>) => {
		const projection: Record<string, string | string[]> = Object.create(null);
		for (const { name } of definition.fields) {
			const value = record[name];
			if (typeof value === 'string') {
				projection[name] = value;
				continue;
			}
			if (Array.isArray(value)) {
				const copied: string[] = [];
				for (const entry of value) {
					if (typeof entry === 'string') copied.push(entry);
					else if (entry != null)
						throw new ClientError(`Full-text source '${name}' contains a non-text array value`, 400);
				}
				projection[name] = copied;
				continue;
			}
			if (value != null) throw new ClientError(`Full-text source '${name}' contains a non-text value`, 400);
		}
		return projection;
	};
}

function fullTextActivationSnapshot(Table: any, definitions: readonly FullTextDefinition[]): string {
	return JSON.stringify(
		definitions.map((definition) => ({
			storage: fullTextStorageDefinition(definition),
			generation: Table.fullTextIndexGenerations?.[definition.name],
		}))
	);
}

export function fullTextDerivedIndexId(Table: any, indexName: string): string {
	return `fulltext:${Table.tableName}/${indexName}`;
}

export function fullTextDerivedIndexReadinessId(Table: any, indexName: string, generation?: string): string {
	return `${fullTextDerivedIndexId(Table, indexName)}:${Table.tableId}:${generation ?? 'missing'}`;
}

export function fullTextDerivedIndexReadiness(Table: any, indexName: string) {
	if (!Table.fullTextIndexes?.some((definition: FullTextDefinition) => definition.name === indexName))
		throw new ClientError(`'${indexName}' is not a full-text index`, 400);
	return readDerivedIndexReadiness(
		Table.auditStore,
		fullTextDerivedIndexReadinessId(Table, indexName, Table.fullTextIndexGenerations?.[indexName])
	);
}

export function setFullTextNativeBindingForTests(configuration: FullTextTestConfiguration | undefined): void {
	fullTextTestConfiguration = configuration;
}
