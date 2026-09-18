import { RocksDatabase } from '@harperfast/rocksdb-js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import type { Attribute } from './Table.ts';
import type { RocksTransactionLogStore } from './RocksTransactionLogStore.ts';
import { createNativeFullTextDerivedIndexBackend } from './NativeFullTextDerivedIndexLifecycle.ts';
import type { NativeFullTextModule } from './fullTextNativeBinding.ts';
import { registerDerivedIndexTables } from './derivedIndexRegistry.ts';
import { DerivedIndexRuntime, readDerivedIndexReadiness } from './derivedIndexRuntime.ts';
import { HnswDerivedIndexBackend, type DerivedNativeIndex } from './indexes/hnswDerivedIndex.ts';
import { fullTextStorageDefinition, type FullTextDefinition } from './fullTextSchema.ts';
import { ownsDerivedIndexWriters } from '../server/threads/manageThreads.js';

const hnswLogger = loggerWithTag('HNSW');
const fullTextLogger = loggerWithTag('fulltext-derived-index');

const DEFAULT_MAX_LAG_MILLISECONDS = 30_000;
const FULL_TEXT_LIMITS = Object.freeze({
	indexingThreads: 1,
	searchThreads: 1,
	writerMemoryBytes: 32 * 1024 * 1024,
	maxQueuedCommands: 16,
	maxQueuedBytes: 64 * 1024 * 1024,
	maxBatchBytes: 8 * 1024 * 1024,
});

type Installed = {
	Table: any;
	close(): Promise<void>;
	canReuse(): boolean;
	readinessOverride(id: string): ReturnType<typeof readDerivedIndexReadiness> | undefined;
};
type Registered = {
	runtime: DerivedIndexRuntime;
	tables: Map<number, { Table: any }>;
	installations: Map<number, Installed>;
};
type Registration = {
	register(): () => Promise<void>;
	release(): Promise<void>;
};
const runtimes = new WeakMap<object, Registered>();
const warnedAuditIndexes = new Set<string>();
let fullTextBindingForTests: NativeFullTextModule | undefined;

function runtimeFor(auditStore: RocksTransactionLogStore): Registered {
	let registered = runtimes.get(auditStore);
	if (registered) return registered;
	const tables = new Map<number, { Table: any }>();
	const runtime = new DerivedIndexRuntime(
		auditStore,
		(tableId, recordId) => {
			const Table = tables.get(tableId)?.Table;
			if (!Table) return;
			const entry = Table.primaryStore.getEntry(recordId);
			return entry?.value == null ? undefined : { version: entry.version, value: entry.value, size: entry.size };
		},
		{
			scanRecords: (tableId) => {
				const Table = tables.get(tableId)?.Table;
				if (!Table) throw new Error(`Derived-index table ${tableId} is no longer registered`);
				return Table.primaryStore
					.getRange({ versions: true, snapshot: false })
					.map(({ key, value, version, size }) => ({ recordId: key, version, value, size }));
			},
		}
	);
	registered = { runtime, tables, installations: new Map() };
	runtimes.set(auditStore, registered);
	return registered;
}

export function attachDerivedIndexes(Table: any): Installed | undefined {
	const hnswAttributes = Table.attributes.filter(
		(attribute: Attribute) => Table.indices[attribute.name]?.customIndex?.postCommit
	);
	const fullTextDefinitions = Table.fullTextIndexes as FullTextDefinition[];
	const auditStore = Table.auditStore as RocksTransactionLogStore;
	const existing = runtimes.get(auditStore);
	let previous = existing?.installations.get(Table.tableId);
	let previousClose: Promise<void> | undefined;
	if (previous) {
		previousClose = previous.close();
		previousClose.then(
			() => {
				previous = undefined;
				previousClose = undefined;
			},
			(error) =>
				fullTextLogger.warn?.(
					`Previous derived indexes for ${Table.databaseName}.${Table.tableName} did not quiesce cleanly`,
					error
				)
		);
	}
	if (hnswAttributes.length === 0 && fullTextDefinitions.length === 0) return previous;
	assertDerivedIndexSupport(Table, fullTextDefinitions);

	const registered = existing ?? runtimeFor(auditStore);
	// A redefinition installs a new table view before the old runner finishes quiescing. Its release
	// must therefore remove only its own view, never the replacement now serving the same table id.
	const registrations: Registration[] = [];
	const install = (register: Registration['register']) => {
		registrations.push({ register, release: register() });
	};
	if (fullTextDefinitions.length > 0) {
		install(() => {
			const unregisterTable = registerDerivedIndexTables(auditStore, [Table.tableId]);
			return async () => unregisterTable();
		});
	}
	const setups: Promise<void>[] = [];
	let closing = false;
	let closed: Promise<void> | undefined;
	let closeComplete = false;
	let reusable = true;
	const readinessOverrides = new Map<string, ReturnType<typeof readDerivedIndexReadiness>>();
	const installed: Installed = {
		Table,
		canReuse: () => reusable && !closing,
		readinessOverride: (id) => readinessOverrides.get(id),
		close() {
			if (closeComplete) return Promise.resolve();
			if (closed) return closed;
			closing = true;
			const releases = registrations.map(({ release }) => {
				try {
					return Promise.resolve(release());
				} catch (error) {
					return Promise.reject(error);
				}
			});
			closed = (async () => {
				const failures: unknown[] = [];
				const preparationResults = await Promise.allSettled([previous?.close(), ...setups]);
				for (const result of preparationResults) if (result.status === 'rejected') failures.push(result.reason);
				const releaseResults = await Promise.allSettled(releases);
				for (const result of releaseResults) if (result.status === 'rejected') failures.push(result.reason);
				if (failures.length) {
					for (let index = 0; index < releaseResults.length; index++) {
						if (releaseResults[index].status !== 'fulfilled') continue;
						try {
							registrations[index].release = registrations[index].register();
						} catch (error) {
							failures.push(error);
						}
					}
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length) throw new AggregateError(failures, 'derived index registrations failed to shut down');
				closeComplete = true;
				if (registered.tables.get(Table.tableId) === installed) registered.tables.delete(Table.tableId);
				if (registered.installations.get(Table.tableId) === installed) registered.installations.delete(Table.tableId);
			})().finally(() => {
				if (!closeComplete) closed = undefined;
			});
			closed.catch(() => {});
			return closed;
		},
	};
	registered.tables.set(Table.tableId, installed);
	registered.installations.set(Table.tableId, installed);
	try {
		for (const attribute of hnswAttributes) registerHnsw(Table, attribute, registered, install);
		for (const definition of ownsDerivedIndexWriters(Table.primaryStore.rootStore.path) ? fullTextDefinitions : []) {
			const readinessId = fullTextDerivedIndexReadinessId(Table, definition);
			readinessOverrides.set(readinessId, { state: 'unknown', ownerEpoch: 0n, rebuildAttempts: 0 });
			const setup = (async () => {
				try {
					await previousClose;
					if (closing) return;
					await registerFullText(Table, definition, registered, install, () => !closing);
					if (!closing) readinessOverrides.delete(readinessId);
				} catch (error) {
					if (closing) return;
					reusable = false;
					readinessOverrides.set(readinessId, {
						state: 'unavailable',
						reason: 'backend-failed',
						ownerEpoch: 0n,
						rebuildAttempts: 0,
					});
					fullTextLogger.error?.(
						`Could not activate full-text index ${Table.databaseName}.${Table.tableName}.${definition.name}`,
						error
					);
				}
			})();
			setups.push(setup);
		}
	} catch (error) {
		void installed
			.close()
			.catch((closeError) =>
				fullTextLogger.warn?.(
					`Derived indexes for ${Table.databaseName}.${Table.tableName} did not quiesce after activation failed`,
					closeError
				)
			);
		throw error;
	}
	return installed;
}

export function getDerivedIndexInstallations(
	auditStore: RocksTransactionLogStore
): ReadonlyArray<{ close(): Promise<void> }> {
	return [...(runtimes.get(auditStore)?.installations.values() ?? [])];
}

function assertDerivedIndexSupport(Table: any, fullTextDefinitions: FullTextDefinition[]): void {
	if (Table.audit !== true) {
		throw new ClientError(
			`Table '${Table.databaseName}.${Table.tableName}' must enable audit logging before using a post-commit derived index`
		);
	}
	assertFullTextActivationSupported(
		Table.primaryStore?.rootStore,
		Table.databaseName,
		Table.tableName,
		Table.attributes,
		fullTextDefinitions
	);
}

export function assertFullTextActivationSupported(
	rootStore: unknown,
	databaseName: string,
	tableName: string,
	attributes: Attribute[],
	fullTextDefinitions: readonly FullTextDefinition[] = []
): void {
	if (fullTextDefinitions.length === 0) return;
	if (!(rootStore instanceof RocksDatabase)) {
		throw new ClientError(
			`Table '${databaseName}.${tableName}' cannot activate @fullText with the LMDB storage engine`,
			400
		);
	}
	const attributesByName = new Map<string, Attribute>(
		attributes.map((attribute: Attribute) => [attribute.name, attribute])
	);
	for (const definition of fullTextDefinitions) {
		const blobSource = definition.fields.find((field) => attributesByName.get(field.name)?.type === 'Blob');
		if (blobSource) {
			throw new ClientError(
				`@fullText index '${databaseName}.${tableName}.${definition.name}' cannot activate Blob source '${blobSource.name}' until derived-index projection supports asynchronous Blob reads`,
				400
			);
		}
		const computedSource = definition.fields.find((field) => attributesByName.get(field.name)?.computed);
		if (computedSource) {
			throw new ClientError(
				`@fullText index '${databaseName}.${tableName}.${definition.name}' cannot activate computed source '${computedSource.name}' until derived-index projection supports versioned resolvers`,
				400
			);
		}
	}
}

function registerHnsw(
	Table: any,
	attribute: Attribute,
	registered: Registered,
	install: (register: Registration['register']) => void
): void {
	const indexStore = Table.indices[attribute.name];
	const index = indexStore.customIndex as DerivedNativeIndex & { postCommit: true };
	const id = `hnsw:${indexStore.name}`;
	const warningKey = `${Table.databaseName}.${Table.tableName}.${indexStore.name}`;
	if (!warnedAuditIndexes.has(warningKey)) {
		warnedAuditIndexes.add(warningKey);
		hnswLogger.warn?.(
			`Derived index ${indexStore.name} requires auditing; the audit API retains full record history for the configured retention window`
		);
	}
	const resolver = Table.propertyResolvers?.[attribute.name];
	const label = `Vector for attribute "${attribute.name}"`;
	index.attachDerivedHost({
		readiness: () => registered.runtime.getReadiness(id),
		requestRebuild: () => registered.runtime.requestRebuild(id),
	});
	install(() =>
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

async function registerFullText(
	Table: any,
	definition: FullTextDefinition,
	registered: Registered,
	install: (register: Registration['register']) => void,
	isCurrent: () => boolean
): Promise<void> {
	const storageDefinition = fullTextStorageDefinition(definition);
	const id = fullTextDerivedIndexId(Table, definition.name);
	const generation = fullTextIndexGeneration(Table, definition);
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
		fields: storageDefinition.fields,
		analyzer: storageDefinition.analyzer,
		stopWords: storageDefinition.stopWords,
		positions: storageDefinition.positions,
		surfaceTerms: storageDefinition.surfaceTerms,
		limits: { ...FULL_TEXT_LIMITS },
		...(fullTextBindingForTests ? { binding: fullTextBindingForTests } : {}),
	});
	if (!isCurrent()) return;
	install(() =>
		registered.runtime.register({
			backend,
			readinessId: fullTextDerivedIndexReadinessId(Table, definition),
			isCurrent: () => currentFullTextIndexGeneration(Table, definition.name) === generation,
			projections: new Map([
				[
					Table.tableId,
					(record: Record<string, unknown>) => {
						const projection: Record<string, string | string[]> = Object.create(null);
						for (const { name } of definition.fields) {
							const value = record[name];
							if (typeof value === 'string') projection[name] = value;
							else if (Array.isArray(value)) {
								let textValues: string[] | undefined;
								for (let index = 0; index < value.length; index++) {
									const entry = value[index];
									if (typeof entry === 'string') {
										if (textValues) textValues.push(entry);
									} else if (entry == null) textValues ??= value.slice(0, index) as string[];
									else throw new ClientError(`Full-text source '${name}' contains a non-text array value`, 400);
								}
								projection[name] = textValues ?? value;
							} else if (value != null)
								throw new ClientError(`Full-text source '${name}' contains a non-text value`, 400);
						}
						return projection;
					},
				],
			]),
			options: { maxLagMilliseconds: 0 },
		})
	);
}

export function fullTextDerivedIndexId(Table: any, indexName: string): string {
	return `fulltext:${Table.tableName}/${indexName}`;
}

function fullTextIndexGeneration(Table: any, definition: FullTextDefinition): string {
	return (
		Table.fullTextIndexGenerations?.[definition.name] ??
		`legacy:${JSON.stringify(fullTextStorageDefinition(definition))}`
	);
}

function currentFullTextIndexGeneration(Table: any, indexName: string): string | undefined {
	const definition = Table.fullTextIndexes?.find((candidate: FullTextDefinition) => candidate.name === indexName);
	if (!definition) return;
	return (
		Table.fullTextIndexGenerations?.[indexName] ?? `legacy:${JSON.stringify(fullTextStorageDefinition(definition))}`
	);
}

function fullTextDerivedIndexReadinessId(Table: any, definition: FullTextDefinition): string {
	return `${fullTextDerivedIndexId(Table, definition.name)}:${Table.tableId}:${fullTextIndexGeneration(Table, definition)}`;
}

export function fullTextDerivedIndexReadiness(Table: any, indexName: string) {
	const definition = Table.fullTextIndexes.find((candidate: FullTextDefinition) => candidate.name === indexName);
	if (!definition) throw new ClientError(`'${indexName}' is not a full-text index`, 400);
	const readinessId = fullTextDerivedIndexReadinessId(Table, definition);
	return (
		Table.derivedIndexRuntime?.readinessOverride?.(readinessId) ??
		readDerivedIndexReadiness(Table.auditStore, readinessId)
	);
}

/** Test-only binding injection; production always loads `@harperfast/fulltext/native`. */
export function setFullTextNativeBindingForTests(binding: NativeFullTextModule | undefined): void {
	fullTextBindingForTests = binding;
}
