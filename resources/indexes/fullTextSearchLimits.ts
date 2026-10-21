import type { NativeFullTextRuntimeBudget } from './fullTextNativeBinding.ts';

export type FullTextSearchLimits = Readonly<{
	requestBudgetMilliseconds: number;
	maxRawHitsPerRequest: number;
	runtime: Readonly<NativeFullTextRuntimeBudget>;
}>;

export const DEFAULT_FULL_TEXT_SEARCH_LIMITS: FullTextSearchLimits = Object.freeze({
	requestBudgetMilliseconds: 5_000,
	maxRawHitsPerRequest: 10_000,
	runtime: Object.freeze({
		maxResidentIndexes: 128,
		maxIndexingThreads: 128,
		maxSearchThreads: 256,
		maxWriterMemoryBytes: 4 * 1024 * 1024 * 1024,
		maxQueuedBytes: 8 * 1024 * 1024 * 1024,
		maxExpensiveSearches: 8,
	}),
});

const policyDefaults = Object.entries(DEFAULT_FULL_TEXT_SEARCH_LIMITS).filter(([name]) => name !== 'runtime');
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
	return Object.freeze({ ...limits, runtime: Object.freeze(budget) }) as FullTextSearchLimits;
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
