import type { NativeFullTextSearchMode } from './fullTextNativeBinding.ts';

export const FULL_TEXT_QUERY_PAUSE_OPERATION = 'pause-full-text-query-readers';
export const FULL_TEXT_QUERY_RESUME_OPERATION = 'resume-full-text-query-readers';

export const FULL_TEXT_POSITIVE_COMPARATORS = [
	'matches',
	'matches_all',
	'matches_phrase',
	'matches_prefix',
	'matches_fuzzy',
	'matches_fuzzy_prefix',
] as const;

type PositiveFullTextComparator = (typeof FULL_TEXT_POSITIVE_COMPARATORS)[number];

const FULL_TEXT_MODES: Record<PositiveFullTextComparator, NativeFullTextSearchMode> = {
	matches: 'any',
	matches_all: 'all',
	matches_phrase: 'phrase',
	matches_prefix: 'prefix',
	matches_fuzzy: 'fuzzy',
	matches_fuzzy_prefix: 'fuzzy-prefix',
};

export const FULL_TEXT_COMPARATORS = [
	...FULL_TEXT_POSITIVE_COMPARATORS,
	...FULL_TEXT_POSITIVE_COMPARATORS.map((comparator) => `not_${comparator}` as const),
] as const;

export function fullTextComparatorMode(comparator: string | undefined): NativeFullTextSearchMode | undefined {
	return comparator !== undefined && Object.hasOwn(FULL_TEXT_MODES, comparator)
		? FULL_TEXT_MODES[comparator as PositiveFullTextComparator]
		: undefined;
}

type FullTextReplayHit = { id: string; score: number; version?: string };

export function fullTextReplayPrefixMatches(
	expected: readonly FullTextReplayHit[],
	actual: readonly FullTextReplayHit[],
	start: number,
	count: number
): boolean {
	for (let i = 0; i < count; i++) {
		const before = expected[start + i];
		const after = actual[i];
		if (!before || !after || before.id !== after.id || before.score !== after.score || before.version !== after.version)
			return false;
	}
	return true;
}
