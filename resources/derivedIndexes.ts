import { RocksDatabase } from '@harperfast/rocksdb-js';
import { ClientError } from '../utility/errors/hdbError.ts';
import { loggerWithTag } from '../utility/logging/logger.ts';
import type { Attribute } from './Table.ts';
import type { RocksTransactionLogStore } from './RocksTransactionLogStore.ts';
import { createNativeFullTextDerivedIndexBackend } from './NativeFullTextDerivedIndexLifecycle.ts';
import type { NativeFullTextModule } from './fullTextNativeBinding.ts';
import { DerivedIndexRuntime, readDerivedIndexReadiness } from './derivedIndexRuntime.ts';
import { HnswDerivedIndexBackend, type DerivedNativeIndex } from './indexes/hnswDerivedIndex.ts';

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

type Installed = { Table: any; close(): Promise<void> };
type Registered = {
	runtime: DerivedIndexRuntime;
	tables: Map<number, { Table: any }>;
	installations: Map<number, Installed>;
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
	registered = { runtime, tables, installations: new Map() };
	runtimes.set(auditStore, registered);
	return registered;
}

/**
 * Register every schema-derived index of a table with its database's shared runtime. Registration
 * runs on every worker; the runtime elects one owner for each physical index.
 */
export function attachDerivedIndexes(Table: any): { close(): Promise<void> } | undefined {
	const hnswAttributes = Table.attributes.filter(
		(attribute: Attribute) => Table.indices[attribute.name]?.customIndex?.postCommit
	);
	const fullTextAttributes = Table.attributes.filter((attribute: Attribute) => attribute.fullText);
	if (hnswAttributes.length === 0 && fullTextAttributes.length === 0) return;
	assertDerivedIndexSupport(Table, fullTextAttributes);

	const auditStore = Table.auditStore as RocksTransactionLogStore;
	const registered = runtimeFor(auditStore);
	const previous = registered.installations.get(Table.tableId);
	if (previous) {
		void previous
			.close()
			.catch((error) =>
				fullTextLogger.warn?.(
					`Previous derived indexes for ${Table.databaseName}.${Table.tableName} did not quiesce cleanly`,
					error
				)
			);
	}
	// A redefinition installs a new table view before the old runner finishes quiescing. Its release
	// must therefore remove only its own view, never the replacement now serving the same table id.
	const releases: Array<() => Promise<void>> = [];
	let closed: Promise<void> | undefined;
	const installed: Installed = {
		Table,
		close() {
			if (closed) return closed;
			closed = Promise.all(releases.map((release) => release())).then(() => {
				if (registered.tables.get(Table.tableId) === installed) registered.tables.delete(Table.tableId);
				if (registered.installations.get(Table.tableId) === installed) registered.installations.delete(Table.tableId);
			});
			return closed;
		},
	};
	registered.tables.set(Table.tableId, installed);
	registered.installations.set(Table.tableId, installed);
	try {
		for (const attribute of hnswAttributes) registerHnsw(Table, attribute, registered, releases);
		for (const attribute of fullTextAttributes) registerFullText(Table, attribute, registered, releases);
	} catch (error) {
		void installed.close();
		throw error;
	}
	return installed;
}

function assertDerivedIndexSupport(Table: any, fullTextAttributes: Attribute[]): void {
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
		fullTextAttributes
	);
}

/** Validate storage/projection capabilities before a schema declaration mutates the live table. */
export function assertFullTextActivationSupported(
	rootStore: unknown,
	databaseName: string,
	tableName: string,
	attributes: Attribute[],
	fullTextAttributes = attributes.filter((attribute) => attribute.fullText)
): void {
	if (fullTextAttributes.length === 0) return;
	if (!(rootStore instanceof RocksDatabase)) {
		throw new ClientError(
			`Table '${databaseName}.${tableName}' cannot activate @fullText with the LMDB storage engine`,
			400
		);
	}
	const attributesByName = new Map<string, Attribute>(
		attributes.map((attribute: Attribute) => [attribute.name, attribute])
	);
	for (const target of fullTextAttributes) {
		const blobSource = target.fullText!.fields.find((field) => attributesByName.get(field.name)?.type === 'Blob');
		if (blobSource) {
			throw new ClientError(
				`@fullText on '${databaseName}.${tableName}.${target.name}' cannot activate Blob source '${blobSource.name}' until derived-index projection supports asynchronous Blob reads`,
				400
			);
		}
	}
}

function registerHnsw(
	Table: any,
	attribute: Attribute,
	registered: Registered,
	releases: Array<() => Promise<void>>
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

function registerFullText(
	Table: any,
	attribute: Attribute,
	registered: Registered,
	releases: Array<() => Promise<void>>
): void {
	const definition = attribute.fullText!;
	const id = fullTextDerivedIndexId(Table, attribute.name);
	const storeName = `${Table.tableName}/${attribute.name}`;
	const warningKey = `${Table.primaryStore.rootStore.path}:${storeName}`;
	if (!warnedAuditIndexes.has(warningKey)) {
		warnedAuditIndexes.add(warningKey);
		fullTextLogger.warn?.(
			`Derived index ${storeName} requires auditing; the audit API retains full record history for the configured retention window`
		);
	}
	const backend = createNativeFullTextDerivedIndexBackend({
		id,
		storePath: Table.primaryStore.rootStore.path,
		storeName,
		sourceGeneration: String(Table.tableId),
		fields: definition.fields.map(({ name, weight }) => ({ name, weight })),
		analyzer: definition.analyzer,
		stopWords: definition.stopWords,
		positions: definition.positions,
		surfaceTerms: definition.surfaceTerms,
		limits: { ...FULL_TEXT_LIMITS },
		...(fullTextBindingForTests ? { binding: fullTextBindingForTests } : {}),
	});
	releases.push(
		registered.runtime.register({
			backend,
			projections: new Map([
				[
					Table.tableId,
					(record: Record<string, unknown>) => {
						const projection: Record<string, string | string[]> = Object.create(null);
						for (const { name } of definition.fields) {
							const value = record[name];
							if (typeof value === 'string') projection[name] = value;
							else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
								projection[name] = value;
						}
						return projection;
					},
				],
			]),
			options: { maxLagMilliseconds: DEFAULT_MAX_LAG_MILLISECONDS },
		})
	);
}

export function fullTextDerivedIndexId(Table: any, attributeName: string): string {
	return `fulltext:${Table.tableName}/${attributeName}`;
}

/** Shared readiness of a full-text index on any worker, registered or not. */
export function fullTextDerivedIndexReadiness(Table: any, attributeName: string) {
	return readDerivedIndexReadiness(Table.auditStore, fullTextDerivedIndexId(Table, attributeName));
}

/** Test-only binding injection; production always loads `@harperfast/fulltext/native`. */
export function setFullTextNativeBindingForTests(binding: NativeFullTextModule | undefined): void {
	fullTextBindingForTests = binding;
}
