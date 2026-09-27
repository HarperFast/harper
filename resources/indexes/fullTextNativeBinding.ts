import type { FullTextDerivedIndexEngine } from './fullTextDerivedIndex.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';

const FULLTEXT_LIFECYCLE_API_VERSION = 1;
const FULLTEXT_MUTATION_BATCH_API_VERSION = 4;
const FULLTEXT_QUERY_API_VERSION = 2;
const logger = loggerWithTag('fulltext-derived-index');

export interface NativeFullTextIndexConfiguration {
	fields: Array<{ name: string; weight?: number }>;
	analyzer: 'english@2';
	stopWords?: boolean;
	positions?: boolean;
	surfaceTerms?: boolean;
	synonyms?: NativeFullTextSynonymRule[];
	limits: {
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

export type NativeFullTextSearchExpression =
	| { text: string; mode?: NativeFullTextSearchMode; operator?: 'any' | 'all'; fields?: string[] }
	| { operator: 'and' | 'or'; clauses: NativeFullTextSearchExpression[] }
	| { operator: 'not'; clause: NativeFullTextSearchExpression };

export type NativeFullTextSearchRequest = {
	text?: string;
	query?: NativeFullTextSearchExpression;
	mode?: NativeFullTextSearchMode;
	operator?: 'any' | 'all';
	fields?: string[];
	candidateIds?: string[];
	offset?: number;
	limit?: number;
	exactTotal?: boolean;
};

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
		maxCommitPayloadBytes: number;
		maxSearchWindow: number;
		maxTraceRecords: number;
		maxTraceSourceBytes: number;
	};
};

export interface NativeFullTextModule {
	NativeFullTextIndex: {
		prototype: Pick<FullTextDerivedIndexEngine, 'applyMutationBatch' | 'publish' | 'close'>;
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
		bindingPromise = import(moduleName).then(validateFullTextNativeBinding);
		bindingPromise.catch((error) => {
			bindingPromise = undefined;
			if (!bindingWarningLogged) {
				bindingWarningLogged = true;
				const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
				try {
					logger.warn?.(
						`The @harperfast/fulltext native module is unavailable${typeof code === 'string' ? ` (${code})` : ''}`
					);
				} catch {}
			}
		});
	}
	return bindingPromise;
}

export async function validateFullTextNativeBinding(module: unknown): Promise<NativeFullTextModule> {
	const prototype = (module as { NativeFullTextIndex?: { prototype?: Partial<FullTextDerivedIndexEngine> } })
		?.NativeFullTextIndex?.prototype;
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
	if (
		!info ||
		typeof info.packageVersion !== 'string' ||
		typeof info.tantivyVersion !== 'string' ||
		!Number.isSafeInteger(info.nativeAbiVersion) ||
		!Number.isSafeInteger(info.queryClassIsolationMinimumSearchThreads) ||
		info.queryClassIsolationMinimumSearchThreads <= 0 ||
		info.lifecycleApiVersion !== FULLTEXT_LIFECYCLE_API_VERSION ||
		info.mutationBatchApiVersion !== FULLTEXT_MUTATION_BATCH_API_VERSION ||
		info.queryApiVersion !== FULLTEXT_QUERY_API_VERSION ||
		!Array.isArray(info.storageBackends) ||
		!info.storageBackends.includes('native') ||
		!info.limits ||
		!Number.isSafeInteger(info.limits.maxCommitPayloadBytes) ||
		info.limits.maxCommitPayloadBytes <= 0 ||
		!Number.isSafeInteger(info.limits.maxSearchWindow) ||
		info.limits.maxSearchWindow <= 0 ||
		!Number.isSafeInteger(info.limits.maxTraceRecords) ||
		info.limits.maxTraceRecords <= 0 ||
		!Number.isSafeInteger(info.limits.maxTraceSourceBytes) ||
		info.limits.maxTraceSourceBytes <= 0
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
