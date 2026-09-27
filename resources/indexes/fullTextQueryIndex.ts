import { createHash } from 'node:crypto';
import { fromBufferKey } from 'ordered-binary';
import { ClientError, DerivedIndexLagError, IndexRebuildingError, ServerError } from '../../utility/errors/hdbError.ts';
import {
	derivedIndexTime,
	readDerivedIndexPublicationRevision,
	readDerivedIndexReadiness,
	type DerivedIndexCoverage,
	type DerivedIndexReadiness,
} from '../derivedIndexRuntime.ts';
import type { FullTextDefinition } from '../fullTextSchema.ts';
import type { RocksTransactionLogStore } from '../RocksTransactionLogStore.ts';
import {
	loadFullTextNativeBinding,
	type NativeFullTextIndexConfiguration,
	type NativeFullTextModule,
	type NativeFullTextReader,
	type NativeFullTextSearchExpression,
	type NativeFullTextSearchMode,
} from './fullTextNativeBinding.ts';
import { nativeFullTextIndexPath } from './nativeFullTextDerivedIndexLifecycle.ts';
import {
	DEFAULT_MAX_INDEX_LAG_MILLISECONDS,
	MAX_WAIT_FOR_INDEX_MILLISECONDS,
	type DerivedNativeIndexHost,
} from './hnswDerivedIndex.ts';

const RAW_PAGE_SIZE = 256;
const HIGHLIGHT_BLOB_READ_TIMEOUT_MILLISECONDS = 5_000;

export type FullTextCondition = {
	attribute?: string;
	value?: string;
	comparator?: string;
	fields?: string[];
	fullTextQuery?: NativeFullTextSearchExpression;
	fullTextLeaves?: Array<{ text: string; mode: NativeFullTextSearchMode; fields?: string[] }>;
	includeHighlights?: boolean;
	maxIndexLagMilliseconds?: number;
	waitForIndexMilliseconds?: number;
};

type ReaderSlot = {
	reader: NativeFullTextReader;
	revision: string;
	configurationRevision: number;
	active: number;
	retired: boolean;
	closeOperation?: Promise<void>;
	idleWaiters?: Array<() => void>;
};

export type FullTextQueryIndexOptions = {
	Table: any;
	definition: FullTextDefinition;
	auditStore: RocksTransactionLogStore;
	readinessId: string;
	indexId: string;
	storePath: string;
	storeName: string;
	sourceGeneration: string;
	limits: NativeFullTextIndexConfiguration['limits'];
	binding?: NativeFullTextModule | (() => Promise<NativeFullTextModule>);
};

export class FullTextQueryIndex {
	readonly filteredSearch = true;
	readonly filePrimary = true;
	readonly #options: FullTextQueryIndexOptions;
	readonly #nativeOptions: NativeFullTextIndexConfiguration & {
		path: string;
		indexId: string;
		generation: string;
	};
	#definition: FullTextDefinition;
	#definitionSnapshot: string;
	#configurationRevision = 0;
	#binding?: NativeFullTextModule;
	#readerSlot?: ReaderSlot;
	#readerOperation?: Promise<ReaderSlot>;
	#retiredReaderSlots = new Set<ReaderSlot>();
	#maxSearchWindow?: number;
	#maxTraceRecords?: number;
	#closed = false;
	#paused = false;
	#derivedHost?: DerivedNativeIndexHost;

	constructor(options: FullTextQueryIndexOptions) {
		this.#options = options;
		this.#definition = options.definition;
		this.#definitionSnapshot = queryDefinitionSnapshot(options.definition);
		this.#nativeOptions = {
			path: nativeFullTextIndexPath(options.storePath, options.storeName),
			indexId: options.indexId,
			generation: digestGeneration(options.sourceGeneration),
			fields: options.definition.fields.map(({ name, weight }) => ({ name, weight })),
			analyzer: options.definition.analyzer,
			stopWords: options.definition.stopWords,
			positions: options.definition.positions,
			surfaceTerms: options.definition.surfaceTerms,
			synonyms: options.definition.synonyms.map(({ source, replacements }) => ({
				source,
				replacements: [...replacements],
			})),
			limits: { ...options.limits },
		};
	}

	updateDefinition(definition: FullTextDefinition): void {
		const snapshot = queryDefinitionSnapshot(definition);
		if (snapshot === this.#definitionSnapshot) return;
		this.#definition = definition;
		this.#definitionSnapshot = snapshot;
		this.#nativeOptions.fields = definition.fields.map(({ name, weight }) => ({ name, weight }));
		this.#configurationRevision++;
	}

	estimateCount(): number {
		const store = this.#options.Table.primaryStore;
		const records =
			typeof store.getEstimatedKeyCount === 'function' ? store.getEstimatedKeyCount() : store.getStats?.().entryCount;
		return Math.max(1, Math.round((Number.isFinite(records) ? records : 20) * 0.05));
	}

	search(
		condition: FullTextCondition,
		context: any,
		options: { filter?: (id: unknown) => boolean; minResults?: number; resultOffset?: number } = {}
	): Promise<Array<{ key: unknown; $score: number; $highlights?: Record<string, unknown>; loadedEntry: any }>> {
		const maxIndexLagMilliseconds = condition.maxIndexLagMilliseconds ?? DEFAULT_MAX_INDEX_LAG_MILLISECONDS;
		const waitForIndexMilliseconds = condition.waitForIndexMilliseconds ?? 0;
		assertFreshnessOptions(maxIndexLagMilliseconds, waitForIndexMilliseconds);
		const waiting = waitForIndexMilliseconds > 0;
		let coverage: DerivedIndexCoverage | undefined;
		const execute = async () => {
			assertReady(
				readDerivedIndexReadiness(this.#options.auditStore, this.#options.readinessId),
				this.#definition.name
			);
			if (waiting) {
				context?.signal?.throwIfAborted();
				const host = this.#derivedHost;
				const state = host?.readiness().state;
				if (state !== 'ready')
					throw new ServerError(
						`Full-text index '${this.#definition.name}' is ${state === 'unavailable' ? 'unavailable' : 'rebuilding'}`,
						503
					);
				await context?.indexSearchStart;
				context?.signal?.throwIfAborted();
				if (options.minResults === 0) return [];
				const started = derivedIndexTime(this.#options.Table.primaryStore.rootStore);
				if (host.coverage(0)?.state !== 'current')
					await host.waitForCoverage(started, waitForIndexMilliseconds, context?.signal);
				context?.signal?.throwIfAborted();
				return this.#search(condition, context, options);
			}
			coverage = this.#queryCoverage(maxIndexLagMilliseconds);
			return this.#search(condition, context, options);
		};
		const operation = execute().catch((error) => {
			if (error === context?.signal?.reason) throw error;
			throw publicSearchError(error, this.#definition.name);
		});
		if (!waiting && coverage) Object.defineProperty(operation, 'indexCoverage', { value: coverage });
		operation.catch(() => {});
		return operation;
	}

	attachDerivedHost(host: DerivedNativeIndexHost): void {
		this.#derivedHost = host;
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#retireAllReaders();
	}

	async pause(): Promise<void> {
		this.#paused = true;
		await this.#retireAllReaders();
	}

	resume(): void {
		if (!this.#closed) this.#paused = false;
	}

	async #search(
		condition: FullTextCondition,
		context: any,
		options: { filter?: (id: unknown) => boolean; minResults?: number; resultOffset?: number }
	): Promise<Array<{ key: unknown; $score: number; $highlights?: Record<string, unknown>; loadedEntry: any }>> {
		const readiness = readDerivedIndexReadiness(this.#options.auditStore, this.#options.readinessId);
		assertReady(readiness, this.#definition.name);
		const revision = readDerivedIndexPublicationRevision(this.#options.auditStore, this.#options.readinessId);
		if (options.minResults === 0) return [];
		const lease = await this.#acquireReader(`${revision.ownerEpoch}:${revision.revision}`);
		const reader = lease.reader;
		try {
			const maxSearchWindow = this.#maxSearchWindow!;
			const query = condition.fullTextQuery ?? leafExpression(condition);
			const bounded = options.minResults !== undefined;
			const target = bounded ? Math.max(1, options.minResults!) : maxSearchWindow;
			if (target > maxSearchWindow)
				throw new ClientError(
					`Full-text query exceeds the ${maxSearchWindow}-result search window; reduce offset or limit`,
					400
				);
			const accepted: Array<{
				key: unknown;
				$score: number;
				$highlights?: Record<string, unknown>;
				nativeId: string;
				record: Record<string, unknown>;
				recordEntry: any;
			}> = [];
			let offset = 0;
			let moreMayExist = false;
			while (accepted.length < target && offset < maxSearchWindow) {
				if (context?.signal?.aborted) throw context.signal.reason ?? new Error('Full-text search aborted');
				const limit = Math.min(Math.max(RAW_PAGE_SIZE, target - accepted.length), maxSearchWindow - offset);
				const result = await reader.search({ query, offset, limit });
				if (!bounded && result.totalRelation === 'exact' && result.total > maxSearchWindow)
					throw new ClientError(
						`Full-text query exceeds the ${maxSearchWindow}-result search window; add a limit`,
						400
					);
				moreMayExist =
					result.totalRelation === 'exact' ? offset + result.hits.length < result.total : result.hits.length === limit;
				if (result.hits.length === 0) break;
				for (const hit of result.hits) {
					const key = decodeNativeId(hit.id, this.#options.Table.tableId);
					const entry = this.#options.Table.primaryStore.getEntry(key, {
						transaction: context && this.#options.Table._readTxnForContext(context),
					});
					if (!entry?.value || hit.version !== String(entry.version)) continue;
					if (options.filter && !options.filter(key)) continue;
					accepted.push({ key, $score: hit.score, nativeId: hit.id, record: entry.value, recordEntry: entry });
					if (accepted.length >= target) break;
				}
				offset += result.hits.length;
				if (!moreMayExist) break;
			}
			if (!bounded && moreMayExist)
				throw new ClientError(`Full-text query exceeds the ${maxSearchWindow}-result search window; add a limit`, 400);
			if (condition.includeHighlights && accepted.length > 0)
				await this.#addHighlights(reader, condition, accepted.slice(options.resultOffset ?? 0));
			return accepted.map((entry) => ({
				key: entry.key,
				$score: entry.$score,
				loadedEntry: entry.recordEntry,
				...(entry.$highlights ? { $highlights: entry.$highlights } : null),
			}));
		} finally {
			await lease.release();
		}
	}

	async #addHighlights(
		reader: NativeFullTextReader,
		condition: FullTextCondition,
		entries: Array<{
			key: unknown;
			$score: number;
			$highlights?: Record<string, unknown>;
			nativeId: string;
			record: Record<string, unknown>;
			recordEntry: any;
		}>
	): Promise<void> {
		const highlighting = this.#definition.highlighting;
		if (!highlighting) return;
		const highlightFields = new Set(
			this.#definition.fields.filter((field) => field.highlight === true).map((field) => field.name)
		);
		if (highlightFields.size === 0) return;
		const leaves = (condition.fullTextLeaves ?? [leafDescriptor(condition)]).map((leaf) => ({
			...leaf,
			fields: leaf.fields?.filter((field) => highlightFields.has(field)) ?? [...highlightFields],
		}));
		const sourceFieldNames = new Set(leaves.flatMap(({ fields }) => fields));
		if (sourceFieldNames.size === 0) return;
		const byId = new Map(entries.map((entry) => [entry.nativeId, entry]));
		for (let start = 0; start < entries.length; start += this.#maxTraceRecords!) {
			const records = (
				await Promise.all(
					entries.slice(start, start + this.#maxTraceRecords!).map(async ({ nativeId, record }) => {
						try {
							return { id: nativeId, fields: await sourceFields(record, this.#definition, sourceFieldNames) };
						} catch {
							return undefined;
						}
					})
				)
			).filter(Boolean) as Array<{ id: string; fields: Record<string, string | string[]> }>;
			if (records.length === 0) continue;
			for (const leaf of leaves) {
				const fields = leaf.fields;
				if (fields.length === 0) continue;
				const leafFields = new Set(fields);
				const traced = await reader.traceMatches({ text: leaf.text, mode: leaf.mode, fields }, records, {
					snippets: true,
					fragmentLength: highlighting.fragmentLength,
					maxFragmentsPerValue: highlighting.maxFragments,
				});
				for (const record of traced.records) {
					const entry = byId.get(record.id);
					if (!entry) continue;
					const highlights = (entry.$highlights ??= Object.create(null));
					for (const value of record.values) {
						if (!leafFields.has(value.field)) continue;
						const values = (highlights[value.field] ??= []) as unknown[];
						values.push({
							valueIndex: value.valueIndex,
							spans: value.spans,
							...(value.fragments ? { fragments: value.fragments } : null),
						});
					}
				}
			}
		}
	}

	async #acquireReader(revision: string): Promise<{ reader: NativeFullTextReader; release: () => Promise<void> }> {
		const slot = await this.#readerFor(revision);
		if (slot.retired) return this.#acquireReader(revision);
		slot.active++;
		let released = false;
		return {
			reader: slot.reader,
			release: async () => {
				if (released) return;
				released = true;
				slot.active--;
				if (slot.active === 0) {
					for (const resolve of slot.idleWaiters?.splice(0) ?? []) resolve();
					if (slot.retired) await this.#closeReaderSlot(slot);
				}
			},
		};
	}

	#readerFor(revision: string): Promise<ReaderSlot> {
		if (this.#closed) return Promise.reject(new ServerError('Full-text index is closed', 503));
		if (this.#paused)
			return Promise.reject(new IndexRebuildingError(`Full-text index '${this.#definition.name}' is not ready`));
		const current = this.#readerSlot;
		if (
			current &&
			!current.retired &&
			current.revision === revision &&
			current.configurationRevision === this.#configurationRevision
		)
			return Promise.resolve(current);
		if (this.#readerOperation) return this.#readerOperation.then(() => this.#readerFor(revision));
		const configurationRevision = this.#configurationRevision;
		this.#readerOperation = (async () => {
			const existing = this.#readerSlot;
			try {
				let reader: NativeFullTextReader;
				if (existing && existing.active === 0 && existing.configurationRevision === configurationRevision) {
					await existing.reader.reload();
					reader = existing.reader;
					existing.retired = true;
					this.#retiredReaderSlots.delete(existing);
				} else {
					const binding = await this.#getBinding();
					reader = await binding.openNativeFullTextReader(this.#nativeOptions);
					if (existing) this.#retireReaderSlot(existing);
				}
				const slot = { reader, revision, configurationRevision, active: 0, retired: false };
				this.#readerSlot = slot;
				return slot;
			} catch (error) {
				if (existing && existing.active === 0) {
					this.#readerSlot = undefined;
					this.#retireReaderSlot(existing);
				}
				throw publicSearchError(error, this.#definition.name);
			} finally {
				this.#readerOperation = undefined;
			}
		})();
		return this.#readerOperation.then(() => this.#readerFor(revision));
	}

	#retireReaderSlot(slot: ReaderSlot): void {
		if (slot.retired) return;
		slot.retired = true;
		this.#retiredReaderSlots.add(slot);
		if (this.#readerSlot === slot) this.#readerSlot = undefined;
		if (slot.active === 0) this.#closeReaderSlot(slot).catch(() => {});
	}

	#closeReaderSlot(slot: ReaderSlot): Promise<void> {
		if (!slot.closeOperation) {
			slot.closeOperation = slot.reader.close().then(() => {
				this.#retiredReaderSlots.delete(slot);
			});
		}
		return slot.closeOperation;
	}

	async #retireAllReaders(): Promise<void> {
		await this.#readerOperation?.catch(() => undefined);
		if (this.#readerSlot) this.#retireReaderSlot(this.#readerSlot);
		await Promise.all([...this.#retiredReaderSlots].map((slot) => this.#closeWhenIdle(slot)));
	}

	async #closeWhenIdle(slot: ReaderSlot): Promise<void> {
		if (slot.active > 0) await new Promise<void>((resolve) => (slot.idleWaiters ??= []).push(resolve));
		await this.#closeReaderSlot(slot);
	}

	async #getBinding(): Promise<NativeFullTextModule> {
		if (this.#binding) return this.#binding;
		const configured = this.#options.binding;
		this.#binding = configured
			? typeof configured === 'function'
				? await configured()
				: configured
			: await loadFullTextNativeBinding();
		const info = await this.#binding.runtimeInfo();
		this.#maxSearchWindow = info.limits.maxSearchWindow;
		this.#maxTraceRecords = info.limits.maxTraceRecords;
		return this.#binding;
	}

	#queryCoverage(maxLagMilliseconds: number): DerivedIndexCoverage {
		const coverage = this.#derivedHost?.coverage(maxLagMilliseconds);
		if (!coverage || coverage.state === 'unknown') {
			const age = coverage?.lagUpperBoundMilliseconds;
			throw new DerivedIndexLagError(
				`Cannot certify full-text index coverage within ${maxLagMilliseconds} ms` +
					(age === undefined ? '; freshness is unknown' : `; last certified ${Math.ceil(age)} ms ago`) +
					'; retry this query'
			);
		}
		return coverage;
	}
}

function assertFreshnessOptions(maxIndexLagMilliseconds: number, waitForIndexMilliseconds: number): void {
	if (
		typeof maxIndexLagMilliseconds !== 'number' ||
		!Number.isFinite(maxIndexLagMilliseconds) ||
		maxIndexLagMilliseconds < 0
	)
		throw new ClientError('maxIndexLagMilliseconds must be a finite nonnegative number');
	if (
		typeof waitForIndexMilliseconds !== 'number' ||
		!Number.isFinite(waitForIndexMilliseconds) ||
		waitForIndexMilliseconds < 0 ||
		waitForIndexMilliseconds > MAX_WAIT_FOR_INDEX_MILLISECONDS
	)
		throw new ClientError(
			`waitForIndexMilliseconds must be a finite number between 0 and ${MAX_WAIT_FOR_INDEX_MILLISECONDS}`
		);
}

export function fullTextComparatorMode(comparator: string | undefined): NativeFullTextSearchMode | undefined {
	switch (comparator) {
		case 'matches':
			return 'any';
		case 'matches_all':
			return 'all';
		case 'matches_phrase':
			return 'phrase';
		case 'matches_prefix':
			return 'prefix';
		case 'matches_fuzzy':
			return 'fuzzy';
		case 'matches_fuzzy_prefix':
			return 'fuzzy-prefix';
	}
}

function leafExpression(condition: FullTextCondition): NativeFullTextSearchExpression {
	const leaf = leafDescriptor(condition);
	return { text: leaf.text, mode: leaf.mode, ...(leaf.fields ? { fields: leaf.fields } : null) };
}

function leafDescriptor(condition: FullTextCondition): {
	text: string;
	mode: NativeFullTextSearchMode;
	fields?: string[];
} {
	const mode = fullTextComparatorMode(condition.comparator);
	if (!mode || typeof condition.value !== 'string' || condition.value.length === 0)
		throw new ClientError('Full-text conditions require a supported comparator and non-empty string value', 400);
	return { text: condition.value, mode, ...(condition.fields ? { fields: condition.fields } : null) };
}

async function sourceFields(
	record: Record<string, unknown>,
	definition: FullTextDefinition,
	selected: ReadonlySet<string>
): Promise<Record<string, string | string[]>> {
	const fields: Record<string, string | string[]> = Object.create(null);
	const deadline = Date.now() + HIGHLIGHT_BLOB_READ_TIMEOUT_MILLISECONDS;
	for (const source of definition.fields) {
		if (!selected.has(source.name)) continue;
		const value = record[source.name];
		if (typeof value === 'string') fields[source.name] = value;
		else if (Array.isArray(value)) fields[source.name] = value.filter((entry) => typeof entry === 'string');
		else if (source.mediaType === 'text/plain' && value instanceof Blob) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) continue;
			try {
				fields[source.name] = new TextDecoder('utf-8', { fatal: true }).decode(
					await withTimeout(value.arrayBuffer(), remaining)
				);
			} catch {}
		}
	}
	return fields;
}

function decodeNativeId(id: string, tableId: number): unknown {
	const prefix = `${tableId}.`;
	if (!id.startsWith(prefix)) throw new ServerError('Full-text index returned an invalid record identity', 500);
	try {
		return fromBufferKey(Buffer.from(id.slice(prefix.length), 'base64url'));
	} catch {
		throw new ServerError('Full-text index returned an invalid record identity', 500);
	}
}

function assertReady(readiness: DerivedIndexReadiness, name: string): void {
	if (readiness.state === 'ready') return;
	if (readiness.state === 'unavailable') throw new ServerError(`Full-text index '${name}' is unavailable`, 503);
	throw new IndexRebuildingError(`Full-text index '${name}' is not ready`);
}

function publicSearchError(error: unknown, name: string): Error {
	const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
	if (
		code === 'E_INDEX_NOT_READY' ||
		code === 'E_INDEX_CORRUPT' ||
		code === 'E_RELOAD_FAILED' ||
		code === 'E_SCHEMA_MISMATCH' ||
		code === 'E_INDEX_FORMAT_INCOMPATIBLE'
	)
		return new IndexRebuildingError(`Full-text index '${name}' is not ready`);
	if (code === 'E_QUEUE_FULL' || code === 'E_TIMEOUT' || code === 'E_RESOURCE_LIMIT')
		return new ServerError(`Full-text index '${name}' is busy`, 503);
	if (code === 'E_INVALID_ARGUMENT' || code === 'E_PREFIX_TOO_BROAD')
		return new ClientError(`Full-text query on '${name}' is invalid`, 400);
	if (code === 'E_RESULT_TOO_LARGE') return new ClientError(`Full-text query on '${name}' is too large`, 413);
	if (error instanceof ClientError || error instanceof ServerError) return error;
	return new ServerError(`Full-text search on '${name}' failed`, 500);
}

function digestGeneration(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function queryDefinitionSnapshot(definition: FullTextDefinition): string {
	return JSON.stringify({
		fields: definition.fields.map(({ name, weight, highlight }) => ({ name, weight, highlight })),
		highlighting: definition.highlighting,
	});
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Full-text highlight source read timed out')), milliseconds);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}
