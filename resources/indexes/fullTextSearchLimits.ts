export type FullTextSearchLimits = Readonly<{ maxRawHitsPerRequest: number }>;

export const DEFAULT_FULL_TEXT_SEARCH_LIMITS: FullTextSearchLimits = Object.freeze({ maxRawHitsPerRequest: 100_000 });

export function resolveFullTextSearchLimits(value: unknown): FullTextSearchLimits {
	if (value === undefined) return DEFAULT_FULL_TEXT_SEARCH_LIMITS;
	if (
		!value ||
		typeof value !== 'object' ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		throw new TypeError('storage.fullText must be an object');
	for (const name of Object.keys(value))
		if (!Object.hasOwn(DEFAULT_FULL_TEXT_SEARCH_LIMITS, name))
			throw new TypeError(`Unknown storage.fullText option '${name}'`);
	let maximum = (value as Record<string, unknown>).maxRawHitsPerRequest;
	if (maximum === undefined) maximum = DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxRawHitsPerRequest;
	if (typeof maximum === 'string' && /^\d+$/.test(maximum)) maximum = Number(maximum);
	if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1)
		throw new TypeError('storage.fullText.maxRawHitsPerRequest must be a positive safe integer');
	return Object.freeze({ maxRawHitsPerRequest: maximum });
}
