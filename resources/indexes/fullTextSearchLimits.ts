import type { NativeFullTextRuntimeBudget } from './fullTextNativeBinding.ts';

export type FullTextQueryLimits = Readonly<{
	maxQueryTerms: number;
	maxQueryClauses: number;
	maxFuzzyDistance: number;
}>;

export const DEFAULT_FULL_TEXT_QUERY_LIMITS: FullTextQueryLimits = Object.freeze({
	maxQueryTerms: 64,
	maxQueryClauses: 256,
	maxFuzzyDistance: 1,
});

export function resolveFullTextQueryLimits(value: unknown): FullTextQueryLimits {
	if (value === undefined) return DEFAULT_FULL_TEXT_QUERY_LIMITS;
	const config = object(value, 'storage.fullText.query');
	const result = {} as Record<string, number>;
	for (const [name, fallback] of Object.entries(DEFAULT_FULL_TEXT_QUERY_LIMITS)) {
		let value = config[name] === undefined ? fallback : config[name];
		if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
		if (name === 'maxFuzzyDistance' && value === 0) result[name] = 0;
		else result[name] = positiveInteger(value, `storage.fullText.query.${name}`);
	}
	for (const name of Object.keys(config))
		if (!Object.hasOwn(DEFAULT_FULL_TEXT_QUERY_LIMITS, name))
			throw new TypeError(`Unknown storage.fullText.query option '${name}'`);
	for (const [name, ceiling] of [
		['maxQueryTerms', 1024],
		['maxQueryClauses', 4096],
		['maxFuzzyDistance', 2],
	] as const)
		if (result[name] > ceiling) throw new TypeError(`storage.fullText.query.${name} must not exceed ${ceiling}`);
	return Object.freeze(result) as FullTextQueryLimits;
}

export type FullTextSearchLimits = Readonly<{
	requestBudgetMilliseconds: number;
	maxRawHitsPerRequest: number;
	maxResultsPerRequest: number;
	query: FullTextQueryLimits;
	runtime: Readonly<NativeFullTextRuntimeBudget>;
}>;

export const DEFAULT_FULL_TEXT_SEARCH_LIMITS: FullTextSearchLimits = Object.freeze({
	requestBudgetMilliseconds: 5_000,
	maxRawHitsPerRequest: 10_000,
	maxResultsPerRequest: 10_000,
	query: DEFAULT_FULL_TEXT_QUERY_LIMITS,
	runtime: Object.freeze({
		maxResidentIndexes: 128,
		maxIndexingThreads: 128,
		maxSearchThreads: 256,
		maxWriterMemoryBytes: 4 * 1024 * 1024 * 1024,
		maxQueuedBytes: 8 * 1024 * 1024 * 1024,
		maxExpensiveSearches: 8,
	}),
});

const policyDefaults = Object.entries(DEFAULT_FULL_TEXT_SEARCH_LIMITS).filter(
	([name]) => name !== 'runtime' && name !== 'query'
);
const runtimeDefaults = Object.entries(DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime);

export function resolveFullTextSearchLimits(value: unknown): FullTextSearchLimits {
	if (value === undefined) return DEFAULT_FULL_TEXT_SEARCH_LIMITS;
	const config = object(value, 'storage.fullText');
	const runtime = object(config.runtime, 'storage.fullText.runtime');
	const limits = {} as Record<string, number>;
	for (const [name, fallback] of policyDefaults)
		limits[name] = positiveInteger(config[name] === undefined ? fallback : config[name], `storage.fullText.${name}`);
	const budget = {} as Record<string, number>;
	for (const [name, fallback] of runtimeDefaults)
		budget[name] = positiveInteger(
			runtime[name] === undefined ? fallback : runtime[name],
			`storage.fullText.runtime.${name}`
		);
	for (const name of Object.keys(config))
		if (!Object.hasOwn(DEFAULT_FULL_TEXT_SEARCH_LIMITS, name))
			throw new TypeError(`Unknown storage.fullText option '${name}'`);
	for (const name of Object.keys(runtime))
		if (!Object.hasOwn(DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime, name))
			throw new TypeError(`Unknown storage.fullText.runtime option '${name}'`);
	for (const name of ['maxResidentIndexes', 'maxIndexingThreads', 'maxSearchThreads', 'maxExpensiveSearches'])
		if (budget[name] > 0xffffffff) throw new TypeError(`storage.fullText.runtime.${name} must fit a u32`);
	return Object.freeze({
		...limits,
		query: resolveFullTextQueryLimits(config.query),
		runtime: Object.freeze(budget),
	}) as FullTextSearchLimits;
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (
		!value ||
		typeof value !== 'object' ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		throw new TypeError(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
	if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
		throw new TypeError(`${name} must be a positive safe integer`);
	return value;
}
