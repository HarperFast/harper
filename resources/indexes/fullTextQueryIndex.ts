import { createHash } from 'node:crypto';
import { fromBufferKey } from 'ordered-binary';
import { ClientError, DerivedIndexLagError, IndexRebuildingError, ServerError } from '../../utility/errors/hdbError.ts';
import {
	derivedIndexTime,
	readDerivedIndexCoverage,
	readDerivedIndexReadiness,
	subscribeDerivedIndexPublications,
	type DerivedIndexCoverage,
	type DerivedIndexPublicationSubscription,
	type DerivedIndexReadiness,
} from '../derivedIndexRuntime.ts';
import type { FullTextDefinition } from '../fullTextSchema.ts';
import type { RocksTransactionLogStore } from '../RocksTransactionLogStore.ts';
import {
	loadFullTextNativeBinding,
	nativeFullTextSearchThreads,
	validateFullTextQueryRuntimeInfo,
	type NativeFullTextIndexConfiguration,
	type NativeFullTextModule,
	type NativeFullTextReader,
	type NativeFullTextSearchExpression,
	type NativeFullTextSearchMode,
} from './fullTextNativeBinding.ts';
import { nativeFullTextIndexPath } from './nativeFullTextDerivedIndexLifecycle.ts';
import { decodeFullTextPublication, type FullTextPublication } from './fullTextDerivedIndex.ts';
import { fullTextComparatorMode } from './fullTextQueryProtocol.ts';
export {
	FULL_TEXT_QUERY_PAUSE_OPERATION,
	FULL_TEXT_QUERY_RESUME_OPERATION,
	fullTextComparatorMode,
} from './fullTextQueryProtocol.ts';
import {
	DEFAULT_MAX_INDEX_LAG_MILLISECONDS,
	MAX_WAIT_FOR_INDEX_MILLISECONDS,
	type DerivedNativeIndexHost,
} from './hnswDerivedIndex.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const RAW_PAGE_SIZE = 256;
const MIN_RAW_PAGE_SIZE = 32;
const RAW_PAGE_OVERFETCH_FACTOR = 2;
const MAX_RELOAD_FAILURES_BEFORE_REOPEN = 3;
const HIGHLIGHT_BLOB_READ_TIMEOUT_MILLISECONDS = 5_000;
const READER_DRAIN_GRACE_MILLISECONDS = 1_000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const logger = loggerWithTag('fulltext-query-index');

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
	ownerEpoch: bigint;
	publicationGeneration: bigint;
	publication: FullTextPublication;
	configurationRevision: number;
	active: number;
	retired: boolean;
	closeOperation?: Promise<void>;
	idleWaiters?: Array<() => void>;
	reloadFailures: number;
};

type FullTextQueryHost = Pick<DerivedNativeIndexHost, 'readiness' | 'waitForCoverage' | 'requestRebuild'>;

class FullTextReaderPublicationError extends Error {}

const queryIndexesByPath = new Map<string, Set<FullTextQueryIndex>>();
type QueryPauses = Map<string, bigint>;
const pausedQueryPaths = new Map<string, QueryPauses>();

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
	#maxAutocompleteResults?: number;
	#maxSearchBudgetMilliseconds?: number;
	#maxTraceRecords?: number;
	#maxTraceSourceBytes?: number;
	#closed = false;
	#pauses: QueryPauses = new Map();
	#derivedHost?: FullTextQueryHost;
	readonly #derivedHostReady = Promise.withResolvers<FullTextQueryHost>();
	#publicationSubscription?: DerivedIndexPublicationSubscription;
	#publicationRebuildRequested = false;
	#refreshFailureWarned = false;

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
		let indexes = queryIndexesByPath.get(this.#nativeOptions.path);
		if (!indexes) queryIndexesByPath.set(this.#nativeOptions.path, (indexes = new Set()));
		indexes.add(this);
		const pauses = pausedQueryPaths.get(this.#nativeOptions.path);
		if (pauses) this.#pauses = new Map(pauses);
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
		options: {
			filter?: (id: unknown, entry?: any) => boolean;
			minResults?: number;
			resultOffset?: number;
			assertTransactionActive?: () => void;
		} = {}
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
				await context?.indexSearchStart;
				context?.signal?.throwIfAborted();
				const waitDeadline = performance.now() + waitForIndexMilliseconds;
				const started = derivedIndexTime(this.#options.Table.primaryStore.rootStore);
				let host = this.#derivedHost;
				if (!host) {
					const remaining = waitDeadline - performance.now();
					if (remaining <= 0)
						throw new DerivedIndexLagError('Timed out waiting for the local full-text query host; retry this query');
					host = await this.#waitForDerivedHost(remaining, context?.signal);
				}
				const state = host?.readiness().state;
				if (state !== 'ready')
					throw new ServerError(
						`Full-text index '${this.#definition.name}' is ${state === 'unavailable' ? 'unavailable' : 'rebuilding'}`,
						503
					);
				context?.signal?.throwIfAborted();
				if (options.minResults === 0) return [];
				if (this.#readCoverage(0).state !== 'current') {
					await host.waitForCoverage(started, Math.max(0, waitDeadline - performance.now()), context?.signal);
				}
				context?.signal?.throwIfAborted();
				return this.#search(condition, context, options);
			}
			coverage = this.#queryCoverage(maxIndexLagMilliseconds);
			return this.#search(condition, context, options);
		};
		const operation = execute().catch((error) => {
			if (error === context?.signal?.reason) throw error;
			if (nativeErrorNeedsRebuild(error)) {
				this.#requestRebuild();
				void this.#retireAllReaders().catch(() => undefined);
			}
			throw publicSearchError(error, this.#definition.name);
		});
		if (!waiting && coverage) Object.defineProperty(operation, 'indexCoverage', { value: coverage });
		operation.catch(() => {});
		return operation;
	}

	attachDerivedHost(host: FullTextQueryHost): void {
		this.#derivedHost = host;
		this.#derivedHostReady.resolve(host);
	}

	async #waitForDerivedHost(timeout: number, signal?: AbortSignal): Promise<FullTextQueryHost> {
		signal?.throwIfAborted();
		let timer: NodeJS.Timeout;
		let abort: (() => void) | undefined;
		const unavailable = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() =>
					reject(new DerivedIndexLagError('Timed out waiting for the local full-text query host; retry this query')),
				timeout
			);
			if (signal) {
				abort = () => reject(signal.reason ?? new Error('Index wait aborted'));
				signal.addEventListener('abort', abort, { once: true });
			}
		});
		try {
			return await Promise.race([this.#derivedHostReady.promise, unavailable]);
		} finally {
			clearTimeout(timer!);
			if (abort) signal!.removeEventListener('abort', abort);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#publicationSubscription?.close();
		const retirement = this.#retireAllReaders();
		void retirement.then(
			() => this.#unregister(),
			() => undefined
		);
		await withTimeout(
			retirement,
			(this.#maxSearchBudgetMilliseconds ?? 30_000) + READER_DRAIN_GRACE_MILLISECONDS,
			() => new ServerError('Full-text reader drain did not settle before timeout', 503)
		);
	}

	async pause(readinessId: string, ownerEpoch: bigint): Promise<void> {
		const current = this.#pauses.get(readinessId);
		if (current !== undefined && current > ownerEpoch) return;
		if (current !== ownerEpoch)
			logger.info?.(
				`Pausing full-text readers for '${this.#definition.name}' while '${readinessId}' resets at owner epoch ${ownerEpoch}`
			);
		this.#pauses.set(readinessId, ownerEpoch);
		await this.#retireAllReaders();
	}

	resume(readinessId: string, ownerEpoch: bigint): void {
		if (!this.#closed && this.#pauses.get(readinessId) === ownerEpoch) this.#pauses.delete(readinessId);
	}

	async #search(
		condition: FullTextCondition,
		context: any,
		options: {
			filter?: (id: unknown, entry?: any) => boolean;
			minResults?: number;
			resultOffset?: number;
			assertTransactionActive?: () => void;
		}
	): Promise<Array<{ key: unknown; $score: number; $highlights?: Record<string, unknown>; loadedEntry: any }>> {
		const readiness = readDerivedIndexReadiness(this.#options.auditStore, this.#options.readinessId);
		assertReady(readiness, this.#definition.name);
		if (!this.#derivedHost) throw new IndexRebuildingError(`Full-text index '${this.#definition.name}' is not ready`);
		if (options.minResults === 0) return [];
		const publicationGeneration = this.#publicationRevision();
		const lease = await this.#acquireReader(readiness.ownerEpoch, publicationGeneration);
		const reader = lease.reader;
		try {
			const deadline = performance.now() + this.#maxSearchBudgetMilliseconds!;
			const maxSearchWindow = this.#maxSearchWindow!;
			const query = condition.fullTextQuery ?? leafExpression(condition);
			const autocomplete = expressionUsesAutocomplete(query);
			const searchWindow = autocomplete ? this.#maxAutocompleteResults! : maxSearchWindow;
			const bounded = options.minResults !== undefined;
			const target = bounded ? Math.max(1, options.minResults!) : searchWindow;
			if (target > searchWindow)
				throw new ClientError(
					`Full-text query exceeds the ${searchWindow}-result ${autocomplete ? 'autocomplete ' : ''}search window; reduce offset or limit`,
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
			let staleVersionHits = 0;
			const transaction = context && this.#options.Table._readTxnForContext(context);
			while (accepted.length < target && offset < searchWindow) {
				if (context?.signal?.aborted) throw context.signal.reason ?? new Error('Full-text search aborted');
				const desiredPageSize = bounded
					? Math.max(MIN_RAW_PAGE_SIZE, (target - accepted.length) * RAW_PAGE_OVERFETCH_FACTOR)
					: RAW_PAGE_SIZE;
				const limit = autocomplete ? searchWindow : Math.min(RAW_PAGE_SIZE, desiredPageSize, searchWindow - offset);
				const result = await reader.search(
					{
						query,
						offset,
						limit,
						...(!bounded && offset === 0 ? { exactTotal: true } : null),
					},
					{ remainingBudgetMilliseconds: remainingSearchBudget(deadline) }
				);
				if (!bounded && !autocomplete && result.totalRelation === 'exact' && result.total > searchWindow)
					throw new ClientError(`Full-text query exceeds the ${searchWindow}-result search window; add a limit`, 400);
				moreMayExist =
					result.totalRelation === 'exact' ? offset + result.hits.length < result.total : result.hits.length === limit;
				if (result.hits.length === 0) break;
				for (const hit of result.hits) {
					const key = decodeNativeId(hit.id, this.#options.Table.tableId);
					options.assertTransactionActive?.();
					const entry = this.#options.Table.primaryStore.getEntry(key, { transaction });
					if (typeof hit.version !== 'string')
						throw new ServerError('Full-text index returned a hit without a source version', 500);
					if (!entry?.value || hit.version !== String(entry.version)) {
						staleVersionHits++;
						continue;
					}
					if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
						staleVersionHits++;
						continue;
					}
					if (options.filter && !options.filter(key, entry)) continue;
					accepted.push({ key, $score: hit.score, nativeId: hit.id, record: entry.value, recordEntry: entry });
					if (accepted.length >= target) break;
				}
				offset += result.hits.length;
				if (autocomplete) break;
				if (!moreMayExist) break;
				if (accepted.length < target) await new Promise((resolve) => setImmediate(resolve));
			}
			if (!bounded && moreMayExist)
				throw new ClientError(`Full-text query exceeds the ${searchWindow}-result search window; add a limit`, 400);
			if (bounded && accepted.length < target && moreMayExist && staleVersionHits > 0)
				throw new DerivedIndexLagError(
					`Full-text index '${this.#definition.name}' changed while searching; retry this query`
				);
			if (bounded && accepted.length < target && moreMayExist)
				throw new ClientError(
					`Full-text filters exhausted the ${searchWindow}-result search window; narrow the query or reduce offset`,
					400
				);
			if (condition.includeHighlights && accepted.length > 0)
				await this.#addHighlights(reader, condition, accepted.slice(options.resultOffset ?? 0), deadline);
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
		}>,
		deadline: number
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
		const byId = new Map(entries.map((entry) => [entry.nativeId, entry]));
		const leafGroups = new Map<string, { fields: string[]; leaves: typeof leaves }>();
		for (const leaf of leaves) {
			if (leaf.fields.length === 0) continue;
			const key = JSON.stringify([...leaf.fields].sort());
			let group = leafGroups.get(key);
			if (!group) {
				const selected = new Set(leaf.fields);
				const fields = this.#definition.fields.map(({ name }) => name).filter((name) => selected.has(name));
				leafGroups.set(key, (group = { fields, leaves: [] }));
			}
			group.leaves.push(leaf);
		}
		for (const { fields, leaves: fieldLeaves } of leafGroups.values()) {
			const leafFields = new Set(fields);
			for (const sourceEntries of traceEntryBatches(
				entries,
				this.#definition,
				leafFields,
				this.#maxTraceRecords!,
				this.#maxTraceSourceBytes!
			)) {
				const records = await Promise.all(
					sourceEntries.map(async ({ nativeId, record }) => ({
						id: nativeId,
						fields: await sourceFields(record, this.#definition, leafFields, deadline),
					}))
				);
				for (const leaf of fieldLeaves) {
					for (const traceRecords of traceSourceBatches(records, this.#maxTraceSourceBytes!)) {
						const traced = await reader.traceMatches({ text: leaf.text, mode: leaf.mode, fields }, traceRecords, {
							remainingBudgetMilliseconds: remainingSearchBudget(deadline),
							snippets: true,
							fragmentLength: highlighting.fragmentLength,
							maxFragmentsPerValue: highlighting.maxFragments,
						});
						if (!traced.complete) throw new ServerError('Full-text index returned incomplete highlights', 500);
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
		}
	}

	async #acquireReader(
		ownerEpoch: bigint,
		publicationGeneration: bigint
	): Promise<{ reader: NativeFullTextReader; release: () => Promise<void> }> {
		const slot = await this.#readerFor(ownerEpoch, publicationGeneration, true);
		let released = false;
		return {
			reader: slot.reader,
			release: () => {
				if (released) return Promise.resolve();
				released = true;
				slot.active--;
				if (slot.active === 0) {
					for (const resolve of slot.idleWaiters?.splice(0) ?? []) resolve();
					if (slot.retired) {
						try {
							void this.#closeReaderSlot(slot).catch((error) => this.#warnReaderClose(error));
						} catch {}
					}
				}
				return Promise.resolve();
			},
		};
	}

	#readerFor(ownerEpoch: bigint, publicationGeneration: bigint, reserve = false): Promise<ReaderSlot> {
		if (this.#closed) return Promise.reject(new ServerError('Full-text index is closed', 503));
		for (const [readinessId, pausedEpoch] of this.#pauses) {
			const readiness = readDerivedIndexReadiness(this.#options.auditStore, readinessId);
			const completed = readiness.state === 'ready' && readiness.ownerEpoch >= pausedEpoch;
			if (completed) {
				this.#pauses.delete(readinessId);
				clearPathPause(this.#nativeOptions.path, readinessId, pausedEpoch);
			}
		}
		const blocked = this.#pauses.entries().next();
		if (!blocked.done) {
			const [readinessId, ownerEpoch] = blocked.value;
			return Promise.reject(
				new IndexRebuildingError(
					`Full-text index '${this.#definition.name}' is waiting for reader fence '${readinessId}' at owner epoch ${ownerEpoch}`
				)
			);
		}
		const current = this.#readerSlot;
		if (
			current &&
			!current.retired &&
			current.ownerEpoch === ownerEpoch &&
			current.publicationGeneration >= publicationGeneration &&
			current.configurationRevision === this.#configurationRevision
		) {
			if (reserve) current.active++;
			return Promise.resolve(current);
		}
		if (this.#readerOperation)
			return this.#readerOperation.then(() => this.#readerFor(ownerEpoch, publicationGeneration, reserve));
		const configurationRevision = this.#configurationRevision;
		this.#readerOperation = (async () => {
			const existing = this.#readerSlot;
			const existingMatchesIdentity =
				existing?.ownerEpoch === ownerEpoch && existing.configurationRevision === configurationRevision;
			const canReload = existing?.active === 0 && existingMatchesIdentity;
			try {
				let reader: NativeFullTextReader;
				let publication: FullTextPublication;
				if (canReload) {
					await existing.reader.reload();
					existing.publication = this.#decodeReaderPublication(existing.reader);
					existing.reloadFailures = 0;
					existing.publicationGeneration = publicationGeneration;
					return existing;
				} else {
					const binding = await this.#getBinding();
					reader = await binding.openNativeFullTextReader(this.#nativeOptions);
					try {
						publication = this.#decodeReaderPublication(reader);
					} catch (error) {
						await reader.close().catch((closeError) => this.#warnReaderClose(closeError));
						throw error;
					}
					if (existing) this.#retireReaderSlot(existing);
				}
				const slot = {
					reader,
					ownerEpoch,
					publicationGeneration,
					publication,
					configurationRevision,
					active: 0,
					retired: false,
					reloadFailures: 0,
				};
				this.#readerSlot = slot;
				return slot;
			} catch (error) {
				if (canReload && error instanceof FullTextReaderPublicationError) {
					this.#retireReaderSlot(existing);
				} else if (canReload && ++existing.reloadFailures >= MAX_RELOAD_FAILURES_BEFORE_REOPEN) {
					this.#retireReaderSlot(existing);
				} else if (!canReload && existing && existing.active === 0 && !existingMatchesIdentity) {
					this.#readerSlot = undefined;
					this.#retireReaderSlot(existing);
				}
				throw error;
			} finally {
				this.#readerOperation = undefined;
			}
		})();
		return this.#readerOperation.then(() => this.#readerFor(ownerEpoch, publicationGeneration, reserve));
	}

	#decodeReaderPublication(reader: NativeFullTextReader): FullTextPublication {
		try {
			if (reader.committedPayload === undefined) throw new Error('missing publication');
			const publication = decodeFullTextPublication(reader.committedPayload);
			this.#publicationRebuildRequested = false;
			return publication;
		} catch (cause) {
			this.#requestRebuild();
			throw new FullTextReaderPublicationError(
				`Full-text index '${this.#definition.name}' has no valid search checkpoint`,
				{ cause }
			);
		}
	}

	#refreshReader(openCold: boolean): void {
		try {
			if (this.#closed || (!openCold && !this.#readerSlot && !this.#readerOperation)) return;
			const readiness = readDerivedIndexReadiness(this.#options.auditStore, this.#options.readinessId);
			if (readiness.state !== 'ready') return;
			void this.#readerFor(readiness.ownerEpoch, this.#publicationRevision()).catch((error) => {
				if (nativeErrorNeedsRebuild(error)) this.#requestRebuild();
			});
			this.#refreshFailureWarned = false;
		} catch (error) {
			if (this.#refreshFailureWarned) return;
			this.#refreshFailureWarned = true;
			try {
				logger.warn?.('Could not refresh a full-text reader after native publication', error);
			} catch {}
		}
	}

	#publicationRevision(): bigint {
		if (this.#closed) throw new ServerError('Full-text index is closed', 503);
		if (!this.#publicationSubscription)
			this.#publicationSubscription = subscribeDerivedIndexPublications(
				this.#options.auditStore,
				this.#options.readinessId,
				() => this.#refreshReader(false)
			);
		return this.#publicationSubscription.revision();
	}

	#requestRebuild(): void {
		const host = this.#derivedHost;
		if (!host || this.#publicationRebuildRequested) return;
		try {
			if (host.requestRebuild()) this.#publicationRebuildRequested = true;
		} catch (error) {
			try {
				logger.warn?.(`Could not request a rebuild for full-text index '${this.#definition.name}'`, error);
			} catch {}
		}
	}

	#retireReaderSlot(slot: ReaderSlot): void {
		if (slot.retired) return;
		slot.retired = true;
		this.#retiredReaderSlots.add(slot);
		if (this.#readerSlot === slot) this.#readerSlot = undefined;
		if (slot.active === 0) this.#closeReaderSlot(slot).catch((error) => this.#warnReaderClose(error));
	}

	#closeReaderSlot(slot: ReaderSlot): Promise<void> {
		if (!slot.closeOperation) {
			const operation = Promise.resolve()
				.then(() => slot.reader.close())
				.then((result) => {
					this.#retiredReaderSlots.delete(slot);
					if (result?.cleanupError) this.#warnReaderClose(result.cleanupError);
				});
			slot.closeOperation = operation;
			void operation.catch(() => {
				if (slot.closeOperation === operation) slot.closeOperation = undefined;
			});
		}
		return slot.closeOperation;
	}

	async #retireAllReaders(): Promise<void> {
		await this.#readerOperation?.catch(() => undefined);
		if (this.#readerSlot) this.#retireReaderSlot(this.#readerSlot);
		await Promise.all([...this.#retiredReaderSlots].map((slot) => this.#closeWhenIdle(slot)));
	}

	#unregister(): void {
		const indexes = queryIndexesByPath.get(this.#nativeOptions.path);
		indexes?.delete(this);
		if (indexes?.size === 0) queryIndexesByPath.delete(this.#nativeOptions.path);
	}

	async #closeWhenIdle(slot: ReaderSlot): Promise<void> {
		if (slot.active > 0) await new Promise<void>((resolve) => (slot.idleWaiters ??= []).push(resolve));
		await this.#closeReaderSlot(slot).catch((error) => this.#warnReaderClose(error));
	}

	#warnReaderClose(error: unknown): void {
		try {
			logger.warn?.('Could not close a retired full-text reader; the reader remains retired', error);
		} catch {}
	}

	async #getBinding(): Promise<NativeFullTextModule> {
		if (this.#binding) return this.#binding;
		const configured = this.#options.binding;
		const binding = configured
			? typeof configured === 'function'
				? await configured()
				: configured
			: await loadFullTextNativeBinding();
		const info = validateFullTextQueryRuntimeInfo(await binding.runtimeInfo());
		this.#nativeOptions.limits.searchThreads = nativeFullTextSearchThreads(
			info,
			this.#nativeOptions.limits.searchThreads
		);
		this.#maxSearchWindow = info.limits.maxSearchWindow;
		this.#maxAutocompleteResults = info.limits.maxAutocompleteResults;
		this.#maxSearchBudgetMilliseconds = info.limits.maxSearchBudgetMilliseconds;
		this.#maxTraceRecords = info.limits.maxTraceRecords;
		this.#maxTraceSourceBytes = info.limits.maxTraceSourceBytes;
		return (this.#binding = binding);
	}

	#queryCoverage(maxLagMilliseconds: number): DerivedIndexCoverage {
		const coverage = this.#readCoverage(maxLagMilliseconds);
		if (!coverage || coverage.state === 'unknown') {
			this.#refreshReader(true);
			const age = coverage?.lagUpperBoundMilliseconds;
			throw new DerivedIndexLagError(
				`Cannot certify full-text index coverage within ${maxLagMilliseconds} ms` +
					(age === undefined ? '; freshness is unknown' : `; last certified ${Math.ceil(age)} ms ago`) +
					'; retry this query'
			);
		}
		return coverage;
	}

	#readCoverage(maxLagMilliseconds: number): DerivedIndexCoverage {
		return readDerivedIndexCoverage(
			this.#options.auditStore,
			this.#options.readinessId,
			() => this.#readerSlot?.publication.cursor,
			maxLagMilliseconds
		);
	}
}

export async function pauseNativeFullTextQueryReaders(
	path: string,
	readinessId: string,
	ownerEpoch: bigint
): Promise<void> {
	let pauses = pausedQueryPaths.get(path);
	if (!pauses) pausedQueryPaths.set(path, (pauses = new Map()));
	const current = pauses.get(readinessId);
	if (current === undefined || current <= ownerEpoch) pauses.set(readinessId, ownerEpoch);
	await Promise.all([...(queryIndexesByPath.get(path) ?? [])].map((index) => index.pause(readinessId, ownerEpoch)));
}

export function resumeNativeFullTextQueryReaders(path: string, readinessId: string, ownerEpoch: bigint): void {
	clearPathPause(path, readinessId, ownerEpoch);
	for (const index of queryIndexesByPath.get(path) ?? []) index.resume(readinessId, ownerEpoch);
}

function clearPathPause(path: string, readinessId: string, ownerEpoch: bigint): void {
	const pauses = pausedQueryPaths.get(path);
	if (pauses?.get(readinessId) !== ownerEpoch) return;
	pauses.delete(readinessId);
	if (pauses.size === 0) pausedQueryPaths.delete(path);
}

function assertFreshnessOptions(maxIndexLagMilliseconds: number, waitForIndexMilliseconds: number): void {
	if (
		typeof maxIndexLagMilliseconds !== 'number' ||
		!Number.isFinite(maxIndexLagMilliseconds) ||
		maxIndexLagMilliseconds < 0
	)
		throw new ClientError('maxIndexLagMilliseconds must be a finite nonnegative number', 400);
	if (
		typeof waitForIndexMilliseconds !== 'number' ||
		!Number.isFinite(waitForIndexMilliseconds) ||
		waitForIndexMilliseconds < 0 ||
		waitForIndexMilliseconds > MAX_WAIT_FOR_INDEX_MILLISECONDS
	)
		throw new ClientError(
			`waitForIndexMilliseconds must be a finite number between 0 and ${MAX_WAIT_FOR_INDEX_MILLISECONDS}`,
			400
		);
}

function leafExpression(condition: FullTextCondition): NativeFullTextSearchExpression {
	const leaf = leafDescriptor(condition);
	return { text: leaf.text, mode: leaf.mode, ...(leaf.fields ? { fields: leaf.fields } : null) };
}

function expressionUsesAutocomplete(expression: NativeFullTextSearchExpression): boolean {
	if ('text' in expression) return expression.mode === 'prefix' || expression.mode === 'fuzzy-prefix';
	if (expression.operator === 'not') return expressionUsesAutocomplete(expression.clause);
	return expression.clauses.some(expressionUsesAutocomplete);
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
	selected: ReadonlySet<string>,
	queryDeadline: number
): Promise<Record<string, string | string[]>> {
	const fields: Record<string, string | string[]> = Object.create(null);
	const deadline = Math.min(queryDeadline, performance.now() + HIGHLIGHT_BLOB_READ_TIMEOUT_MILLISECONDS);
	for (const source of definition.fields) {
		if (!selected.has(source.name)) continue;
		const value = record[source.name];
		if (typeof value === 'string') fields[source.name] = value;
		else if (Array.isArray(value)) fields[source.name] = value.filter((entry) => typeof entry === 'string');
		else if (source.mediaType === 'text/plain' && value instanceof Blob) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) throw new DerivedIndexLagError('Full-text highlight source read timed out; retry the query');
			let bytes: ArrayBuffer;
			try {
				bytes = await withTimeout(value.arrayBuffer(), remaining);
			} catch {
				throw new DerivedIndexLagError('Full-text highlight source is temporarily unavailable; retry the query');
			}
			fields[source.name] = UTF8_DECODER.decode(bytes);
		}
	}
	return fields;
}

function traceSourceBytes(fields: Record<string, string | string[]>): number {
	let bytes = 0;
	for (const value of Object.values(fields)) {
		if (typeof value === 'string') bytes += Buffer.byteLength(value);
		else for (const item of value) bytes += Buffer.byteLength(item);
	}
	return bytes;
}

function traceEntryBytes(
	record: Record<string, unknown>,
	definition: FullTextDefinition,
	selected: ReadonlySet<string>
): number {
	let bytes = 0;
	for (const source of definition.fields) {
		if (!selected.has(source.name)) continue;
		const value = record[source.name];
		if (typeof value === 'string') bytes += Buffer.byteLength(value);
		else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === 'string') bytes += Buffer.byteLength(item);
		} else if (source.mediaType === 'text/plain' && value instanceof Blob) bytes += value.size;
	}
	return bytes;
}

function traceEntryBatches<T extends { record: Record<string, unknown> }>(
	entries: T[],
	definition: FullTextDefinition,
	selected: ReadonlySet<string>,
	maxRecords: number,
	maxBytes: number
): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let batchBytes = 0;
	for (const entry of entries) {
		const bytes = traceEntryBytes(entry.record, definition, selected);
		if (bytes > maxBytes)
			throw new ClientError(`Full-text highlight source exceeds the ${maxBytes}-byte native trace limit`, 400);
		if (batch.length > 0 && (batch.length >= maxRecords || batchBytes + bytes > maxBytes)) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(entry);
		batchBytes += bytes;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

function traceSourceBatches<T extends { fields: Record<string, string | string[]> }>(
	records: T[],
	maxBytes: number
): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let batchBytes = 0;
	for (const record of records) {
		const bytes = traceSourceBytes(record.fields);
		if (bytes > maxBytes)
			throw new ClientError(`Full-text highlight source exceeds the ${maxBytes}-byte native trace limit`, 400);
		if (batch.length > 0 && batchBytes + bytes > maxBytes) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(record);
		batchBytes += bytes;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
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
	if (error instanceof FullTextReaderPublicationError)
		return new IndexRebuildingError(`Full-text index '${name}' is not ready`);
	if (error instanceof ClientError || error instanceof ServerError) return error;
	const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
	if (code === 'E_RELOAD_FAILED')
		return new DerivedIndexLagError(
			`Full-text index '${name}' could not refresh its search snapshot; retry this query`
		);
	if (typeof code === 'string' && REBUILD_REQUIRED_CODES.has(code))
		return new IndexRebuildingError(`Full-text index '${name}' is not ready`);
	if (code === 'E_QUEUE_FULL' || code === 'E_TIMEOUT' || code === 'E_RESOURCE_LIMIT')
		return new ServerError(`Full-text index '${name}' is busy`, 503);
	if (code === 'E_INVALID_ARGUMENT' || code === 'E_PREFIX_TOO_BROAD')
		return new ClientError(`Full-text query on '${name}' is invalid`, 400);
	if (code === 'E_RESULT_TOO_LARGE') return new ClientError(`Full-text query on '${name}' is too large`, 413);
	return new ServerError(`Full-text search on '${name}' failed`, 500);
}

function nativeErrorNeedsRebuild(error: unknown): boolean {
	const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
	return typeof code === 'string' && REBUILD_REQUIRED_CODES.has(code);
}

const REBUILD_REQUIRED_CODES = new Set([
	'E_INDEX_NOT_READY',
	'E_INDEX_CORRUPT',
	'E_IDENTITY_MISMATCH',
	'E_INCOMPLETE_CREATE',
	'E_SCHEMA_MISMATCH',
	'E_INDEX_FORMAT_INCOMPATIBLE',
]);

function remainingSearchBudget(deadline: number): number {
	const remaining = Math.floor(deadline - performance.now());
	if (remaining <= 0) throw new ServerError('Full-text search exceeded its execution budget', 503);
	return remaining;
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

function withTimeout<T>(
	promise: Promise<T>,
	milliseconds: number,
	timeoutError: () => Error = () => new Error('Full-text highlight source read timed out')
): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(timeoutError()), milliseconds);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer));
}
