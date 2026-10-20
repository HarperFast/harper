import { ServerError } from '../../utility/errors/hdbError.ts';
import type { NativeFullTextSearchMode } from './fullTextNativeBinding.ts';

export const FULL_TEXT_CONTINUATION_PAGE = Symbol('fullTextContinuationPage');
export const FULL_TEXT_CONTINUATION_VERSION = Symbol('fullTextContinuationVersion');

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

export function hasFullTextContinuationOptions(
	target: { continuation?: unknown; closeContinuation?: unknown } | undefined
): boolean {
	return (
		target?.continuation !== undefined ||
		(target?.closeContinuation !== undefined && target.closeContinuation !== false)
	);
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

export function fullTextHitsAdvance(previous: FullTextReplayHit, next: FullTextReplayHit): boolean {
	return (
		previous.score > next.score ||
		(previous.score === next.score && Buffer.compare(Buffer.from(previous.id), Buffer.from(next.id)) < 0)
	);
}

export function replayFullTextPrefix(
	prefix: readonly FullTextReplayHit[] | undefined,
	remaining: number,
	page: { hits: FullTextReplayHit[]; continuation?: string }
): { skipped: number; remaining: number; hits: FullTextReplayHit[] } {
	if (page.hits.length === 0 && page.continuation !== undefined)
		throw new ServerError('Full-text traversal returned an empty page with more results', 500);
	const skipped = Math.min(remaining, page.hits.length);
	if (skipped > 0 && (!prefix || !fullTextReplayPrefixMatches(prefix, page.hits, prefix.length - remaining, skipped)))
		throw new ServerError('Full-text traversal disagreed with its initial result prefix', 500);
	remaining -= skipped;
	if (remaining > 0 && !page.continuation)
		throw new ServerError('Full-text traversal ended before its previously read hits', 500);
	return { skipped, remaining, hits: skipped > 0 ? page.hits.slice(skipped) : page.hits };
}
