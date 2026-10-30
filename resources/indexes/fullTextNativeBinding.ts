import type { FullTextDerivedIndexEngine } from './fullTextDerivedIndex.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import {
	resolveFullTextQueryLimits,
	resolveFullTextSearchLimits,
	type FullTextQueryLimits,
} from './fullTextSearchLimits.ts';
import { getFullTextRuntimeConfiguration, FullTextWorkerInitializationError } from './fullTextRuntimeConfiguration.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const FULLTEXT_NATIVE_ABI_VERSION = 13;
const FULLTEXT_LIFECYCLE_API_VERSION = 1;
const FULLTEXT_MUTATION_BATCH_API_VERSION = 5;
const FULLTEXT_QUERY_API_VERSION = 7;
const logger = loggerWithTag('fulltext-derived-index');

export interface NativeFullTextRuntimeBudget {
	maxResidentIndexes: number;
	maxIndexingThreads: number;
	maxSearchThreads: number;
	maxWriterMemoryBytes: number;
	maxQueuedBytes: number;
	maxExpensiveSearches: number;
}

export interface NativeFullTextIndexConfiguration {
	fields: Array<{ name: string; weight?: number }>;
	analyzer: 'english@2';
	stopWords?: boolean;
	positions?: boolean;
	surfaceTerms?: boolean;
	synonyms?: NativeFullTextSynonymRule[];
	limits: {
		maxQueryTerms?: number;
		maxQueryClauses?: number;
		indexingThreads: number;
		searchThreads: number;
		writerMemoryBytes: number;
		maxQueuedCommands: number;
		maxQueuedBytes: number;
		maxBatchBytes: number;
	};
}

export type NativeFullTextSynonymRule = { source: string; replacements: string[] };

export type NativeFullTextSearchMode = 'any' | 'all' | 'phrase' | 'prefix' | 'fuzzy' | 'fuzzy-prefix';

export type NativeFullTextFuzzyOptions = { fuzzyDistance?: number; fuzzyTranspositions?: boolean };

export type NativeFullTextSearchExpression =
	| (NativeFullTextFuzzyOptions & {
			text: string;
			mode?: NativeFullTextSearchMode;
			operator?: 'any' | 'all';
			fields?: string[];
	  })
	| { operator: 'and' | 'or'; clauses: NativeFullTextSearchExpression[] }
	| { operator: 'not'; clause: NativeFullTextSearchExpression };

export type NativeFullTextSearchRequest = NativeFullTextFuzzyOptions & {
	text?: string;
	query?: NativeFullTextSearchExpression;
	mode?: NativeFullTextSearchMode;
	operator?: 'any' | 'all';
	fields?: string[];
	offset?: number;
	limit?: number;
	exactTotal?: boolean;
};

export type NativeFullTextSearchPageRequest = Omit<NativeFullTextSearchRequest, 'offset'> & {
	continuation?: string;
};

export type NativeFullTextSearchPageResult = NativeFullTextSearchResult & { continuation?: string };

export type NativeFullTextSearchResult = {
	total: number;
	totalRelation: 'exact' | 'lower-bound';
	hits: Array<{ id: string; score: number; version?: string }>;
};

export type NativeFullTextTraceResult = {
	complete: boolean;
	records: Array<{
		id: string;
		values: Array<{
			field: string;
			valueIndex: number;
			spans: Array<{ start: number; end: number }>;
			fragments?: Array<{ text: string; start: number; spans: Array<{ start: number; end: number }> }>;
		}>;
	}>;
};

export interface NativeFullTextReader {
	readonly committedPayload?: string;
	reload(): Promise<void>;
	search(
		request: NativeFullTextSearchRequest,
		options?: { remainingBudgetMilliseconds?: number }
	): Promise<NativeFullTextSearchResult>;
	searchPage(
		request: NativeFullTextSearchPageRequest,
		options?: { remainingBudgetMilliseconds?: number }
	): Promise<NativeFullTextSearchPageResult>;
	traceMatches(
		request: Omit<NativeFullTextSearchRequest, 'query' | 'offset' | 'limit' | 'exactTotal'> & { text: string },
		records: Array<{ id: string; fields: Record<string, string | string[]> }>,
		options?: {
			remainingBudgetMilliseconds?: number;
			snippets?: boolean;
			fragmentLength?: number;
			maxFragmentsPerValue?: number;
		}
	): Promise<NativeFullTextTraceResult>;
	close(): Promise<{ cleanupError?: unknown }>;
}

export type NativeFullTextRuntimeInfo = {
	packageVersion: string;
	tantivyVersion: string;
	nativeAbiVersion: number;
	queryClassIsolationMinimumSearchThreads: number;
	lifecycleApiVersion: number;
	mutationBatchApiVersion: number;
	queryApiVersion: number;
	storageBackends: ReadonlyArray<'native'>;
	limits: {
		maxConfiguredQueryTerms: number;
		maxConfiguredQueryClauses: number;
		maxCommitPayloadBytes: number;
		maxRecordIdBytes: number;
		maxRecordVersionBytes: number;
		maxCandidateIds?: number;
		maxCandidateBytes?: number;
		maxSearchWindow: number;
		maxSearchPageSize: number;
		maxAutocompleteResults: number;
		maxSearchResponseBytes: number;
		maxSearchBudgetMilliseconds: number;
		maxTraceRecords: number;
		maxTraceSourceBytes: number;
	};
};

export type NativeFullTextQueryRuntimeInfo = Pick<
	NativeFullTextRuntimeInfo,
	'queryClassIsolationMinimumSearchThreads'
> & {
	limits: Pick<
		NativeFullTextRuntimeInfo['limits'],
		| 'maxConfiguredQueryTerms'
		| 'maxConfiguredQueryClauses'
		| 'maxSearchWindow'
		| 'maxSearchPageSize'
		| 'maxAutocompleteResults'
		| 'maxRecordIdBytes'
		| 'maxRecordVersionBytes'
		| 'maxSearchResponseBytes'
		| 'maxSearchBudgetMilliseconds'
		| 'maxTraceRecords'
		| 'maxTraceSourceBytes'
	>;
};

export interface NativeFullTextModule {
	configureNativeFullTextRuntime(limits: NativeFullTextRuntimeBudget): void;
	NativeFullTextIndex: {
		prototype: Pick<FullTextDerivedIndexEngine, 'applyMutationBatch' | 'publish' | 'close'> &
			Pick<NativeFullTextReader, 'searchPage'>;
	};
	runtimeInfo(): Promise<NativeFullTextRuntimeInfo>;
	validateNativeFullTextIndexOptions(
		options: NativeFullTextIndexConfiguration & {
			path: string;
			indexId: string;
			generation: string;
		}
	): void;
	openNativeFullTextIndex(
		options: NativeFullTextIndexConfiguration & {
			path: string;
			indexId: string;
			generation: string;
		}
	): Promise<FullTextDerivedIndexEngine>;
	openNativeFullTextReader(
		options: NativeFullTextIndexConfiguration & {
			path: string;
			indexId: string;
			generation: string;
		}
	): Promise<NativeFullTextReader>;
	inspectNativeFullTextIndex(
		options: Omit<NativeFullTextIndexConfiguration, 'limits'> & {
			path: string;
			indexId: string;
			generation: string;
		}
	):
		| { state: 'missing' | 'cursorless' }
		| { state: 'checkpointed'; committedPayload: string }
		| { state: 'incompatible'; code: string };
	resetNativeFullTextIndex(options: {
		path: string;
		indexId: string;
	}): Promise<{ state: 'missing' } | { state: 'reset'; retiredPath: string }>;
	reclaimRetiredNativeFullTextIndexes(options: {
		path: string;
		retiredPath?: string;
	}): Promise<{ removed: number; failed: number }>;
}

let bindingPromise: Promise<NativeFullTextModule> | undefined;
let bindingWarningLogged = false;
const validatedRuntimeInfo = new WeakMap<NativeFullTextModule, NativeFullTextRuntimeInfo>();

export async function loadFullTextNativeBinding(): Promise<NativeFullTextModule> {
	if (!bindingPromise) {
		const moduleName = '@harperfast/fulltext/native';
		bindingPromise = import(moduleName).then(async (module) => {
			const binding = await validateFullTextNativeBinding(module);
			if (typeof binding.configureNativeFullTextRuntime !== 'function')
				throw new TypeError('@harperfast/fulltext/native does not support process budgets');
			const runtime = resolveFullTextSearchLimits({ runtime: getFullTextRuntimeConfiguration().runtime }).runtime;
			binding.configureNativeFullTextRuntime(runtime);
			try {
				const currentQuery = resolveFullTextQueryLimits(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT_QUERY));
				const capturedQuery = resolveFullTextQueryLimits(getFullTextRuntimeConfiguration().query);
				if (Object.keys(capturedQuery).some((name) => capturedQuery[name] !== currentQuery[name]))
					logger.warn?.('storage.fullText.query changed; restart the Harper process to apply its query policy');
				const requested = resolveFullTextSearchLimits({
					runtime: env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME),
				}).runtime;
				if (Object.keys(runtime).some((name) => runtime[name] !== requested[name]))
					logger.warn?.('storage.fullText.runtime changed; restart the Harper process to apply its new budgets');
			} catch {
				// A diagnostic must not reject an already-configured native binding.
			}
			return binding;
		});
		bindingPromise.catch((error) => {
			bindingPromise = undefined;
			if (!bindingWarningLogged) {
				bindingWarningLogged = true;
				const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
				try {
					logger.warn?.(
						error instanceof FullTextWorkerInitializationError
							? error.message
							: `The @harperfast/fulltext native module is unavailable${typeof code === 'string' ? ` (${code})` : ''}`
					);
				} catch {}
			}
		});
	}
	return bindingPromise;
}

export async function validateFullTextNativeBinding(module: unknown): Promise<NativeFullTextModule> {
	const prototype = (
		module as {
			NativeFullTextIndex?: {
				prototype?: Partial<FullTextDerivedIndexEngine & Pick<NativeFullTextReader, 'searchPage'>>;
			};
		}
	)?.NativeFullTextIndex?.prototype;
	if (
		!module ||
		typeof module !== 'object' ||
		!('runtimeInfo' in module) ||
		typeof module.runtimeInfo !== 'function' ||
		!('NativeFullTextIndex' in module) ||
		typeof module.NativeFullTextIndex !== 'function' ||
		typeof prototype?.applyMutationBatch !== 'function' ||
		typeof prototype.publish !== 'function' ||
		typeof prototype.close !== 'function' ||
		typeof prototype.searchPage !== 'function' ||
		!('openNativeFullTextIndex' in module) ||
		typeof module.openNativeFullTextIndex !== 'function' ||
		!('openNativeFullTextReader' in module) ||
		typeof module.openNativeFullTextReader !== 'function' ||
		!('validateNativeFullTextIndexOptions' in module) ||
		typeof module.validateNativeFullTextIndexOptions !== 'function' ||
		!('inspectNativeFullTextIndex' in module) ||
		typeof module.inspectNativeFullTextIndex !== 'function' ||
		!('resetNativeFullTextIndex' in module) ||
		typeof module.resetNativeFullTextIndex !== 'function' ||
		!('reclaimRetiredNativeFullTextIndexes' in module) ||
		typeof module.reclaimRetiredNativeFullTextIndexes !== 'function'
	)
		throw new TypeError('@harperfast/fulltext/native does not implement the required Harper binding contract');
	const binding = module as NativeFullTextModule;
	const info = await binding.runtimeInfo();
	validateFullTextQueryRuntimeInfo(info);
	if (
		!info ||
		typeof info.packageVersion !== 'string' ||
		typeof info.tantivyVersion !== 'string' ||
		info.nativeAbiVersion !== FULLTEXT_NATIVE_ABI_VERSION ||
		info.lifecycleApiVersion !== FULLTEXT_LIFECYCLE_API_VERSION ||
		info.mutationBatchApiVersion !== FULLTEXT_MUTATION_BATCH_API_VERSION ||
		info.queryApiVersion !== FULLTEXT_QUERY_API_VERSION ||
		!Array.isArray(info.storageBackends) ||
		!info.storageBackends.includes('native') ||
		!info.limits ||
		!Number.isSafeInteger(info.limits.maxCommitPayloadBytes) ||
		info.limits.maxCommitPayloadBytes <= 0
	)
		throw new TypeError('@harperfast/fulltext/native reported incompatible runtime capabilities');
	validatedRuntimeInfo.set(binding, info);
	return binding;
}

export function getValidatedFullTextRuntimeInfo(binding: NativeFullTextModule): NativeFullTextRuntimeInfo {
	const info = validatedRuntimeInfo.get(binding);
	if (!info) throw new Error('Full-text native binding has not been validated');
	return info;
}

export function nativeFullTextSearchThreads(
	info: Pick<NativeFullTextRuntimeInfo, 'queryClassIsolationMinimumSearchThreads'>,
	configured: number
): number {
	const minimum = info.queryClassIsolationMinimumSearchThreads;
	if (!Number.isSafeInteger(minimum) || minimum <= 0)
		throw new TypeError('@harperfast/fulltext/native reported an invalid query-class isolation threshold');
	return Math.max(configured, minimum);
}

export function validateFullTextQueryRuntimeInfo(info: unknown): NativeFullTextQueryRuntimeInfo {
	const runtime = info as NativeFullTextQueryRuntimeInfo;
	if (
		!runtime ||
		typeof runtime !== 'object' ||
		!Number.isSafeInteger(runtime.queryClassIsolationMinimumSearchThreads) ||
		runtime.queryClassIsolationMinimumSearchThreads <= 0 ||
		!runtime.limits ||
		!Number.isSafeInteger(runtime.limits.maxConfiguredQueryTerms) ||
		runtime.limits.maxConfiguredQueryTerms <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxConfiguredQueryClauses) ||
		runtime.limits.maxConfiguredQueryClauses <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxRecordIdBytes) ||
		runtime.limits.maxRecordIdBytes <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxRecordVersionBytes) ||
		runtime.limits.maxRecordVersionBytes <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxSearchWindow) ||
		runtime.limits.maxSearchWindow <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxSearchPageSize) ||
		runtime.limits.maxSearchPageSize <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxAutocompleteResults) ||
		runtime.limits.maxAutocompleteResults <= 0 ||
		runtime.limits.maxAutocompleteResults > runtime.limits.maxSearchWindow ||
		!Number.isSafeInteger(runtime.limits.maxSearchResponseBytes) ||
		runtime.limits.maxSearchResponseBytes <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxSearchBudgetMilliseconds) ||
		runtime.limits.maxSearchBudgetMilliseconds <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxTraceRecords) ||
		runtime.limits.maxTraceRecords <= 0 ||
		!Number.isSafeInteger(runtime.limits.maxTraceSourceBytes) ||
		runtime.limits.maxTraceSourceBytes <= 0
	)
		throw new TypeError('@harperfast/fulltext/native reported incompatible runtime capabilities');
	return runtime;
}

export function nativeFullTextQueryLimits(info: NativeFullTextQueryRuntimeInfo, value: unknown): FullTextQueryLimits {
	const policy = resolveFullTextQueryLimits(value);
	for (const [name, ceiling] of [
		['maxQueryTerms', info.limits.maxConfiguredQueryTerms],
		['maxQueryClauses', info.limits.maxConfiguredQueryClauses],
	] as const)
		if (policy[name] > ceiling)
			throw new TypeError(`storage.fullText.query.${name} exceeds the native runtime ceiling ${ceiling}`);
	return policy;
}
