import { getFullTextQueryPolicy } from './fullTextRuntimeConfiguration.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import type { NativeFullTextFuzzyOptions, NativeFullTextSearchMode } from './fullTextNativeBinding.ts';

export const FULLTEXT_SCORING_NATIVE_ABI_VERSION = 14;
export const FULLTEXT_SCORING_QUERY_API_VERSION = 8;

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

function fullTextReplayPrefixMatches(
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

export function fullTextFuzzyOptions(condition: NativeFullTextFuzzyOptions): NativeFullTextFuzzyOptions | undefined {
	if (condition.fuzzyDistance === undefined && condition.fuzzyTranspositions === undefined) return;
	return {
		...(condition.fuzzyDistance === undefined ? null : { fuzzyDistance: condition.fuzzyDistance }),
		...(condition.fuzzyTranspositions === undefined ? null : { fuzzyTranspositions: condition.fuzzyTranspositions }),
	};
}

export function validateFullTextFuzzyOptions(
	condition: NativeFullTextFuzzyOptions,
	mode?: NativeFullTextSearchMode
): void {
	if (condition.fuzzyDistance === undefined && condition.fuzzyTranspositions === undefined) return;
	if (mode !== 'fuzzy' && mode !== 'fuzzy-prefix')
		throw new ClientError(
			'Fuzzy controls require matches_fuzzy or matches_fuzzy_prefix on a full-text index condition',
			400
		);
	if (
		condition.fuzzyDistance !== undefined &&
		(typeof condition.fuzzyDistance !== 'number' ||
			!Number.isInteger(condition.fuzzyDistance) ||
			condition.fuzzyDistance < 0 ||
			condition.fuzzyDistance > 2)
	)
		throw new ClientError('fuzzyDistance must be an integer between 0 and 2', 400);
	if (condition.fuzzyTranspositions !== undefined && typeof condition.fuzzyTranspositions !== 'boolean')
		throw new ClientError('fuzzyTranspositions must be a boolean', 400);
}

export function validateFullTextScoringOptions(condition: any, mode?: NativeFullTextSearchMode): void {
	if (condition.boost === undefined && condition.should === undefined) return;
	if (!mode || condition.negated || condition.conditions)
		throw new ClientError('Scoring controls require a positive full-text index condition', 400);
	validateFullTextBoost(condition.boost);
	if (condition.should === undefined) return;
	if (
		!Array.isArray(condition.should) ||
		condition.should.length === 0 ||
		condition.should.length > getFullTextQueryPolicy().maxQueryClauses
	)
		throw new ClientError('should must be non-empty and within storage.fullText.query.maxQueryClauses', 400);
	for (const clause of condition.should) {
		if (
			!clause ||
			typeof clause !== 'object' ||
			Array.isArray(clause) ||
			Object.keys(clause).some(
				(name) => !['comparator', 'value', 'fields', 'boost', 'fuzzyDistance', 'fuzzyTranspositions'].includes(name)
			)
		)
			throw new ClientError('should clauses accept only comparator, value, fields, boost and fuzzy controls', 400);
		const clauseMode = fullTextComparatorMode(clause.comparator);
		if (!clauseMode || typeof clause.value !== 'string' || clause.value.length === 0)
			throw new ClientError('should clauses require a positive full-text comparator and non-empty string value', 400);
		validateFullTextBoost(clause.boost);
		validateFullTextFuzzyOptions(clause, clauseMode);
	}
}

function validateFullTextBoost(boost: unknown): void {
	if (boost === undefined) return;
	if (
		typeof boost !== 'number' ||
		!Number.isFinite(Math.fround(boost)) ||
		Math.fround(boost) < 0 ||
		Math.fround(boost) > 100 ||
		Object.is(Math.fround(boost), -0)
	)
		throw new ClientError(
			'boost must be a finite non-negative number at most 100 after float32 rounding, excluding negative zero',
			400
		);
}

export function validateFullTextScoringRuntime(queryApiVersion: number | undefined): void {
	if (queryApiVersion !== FULLTEXT_SCORING_QUERY_API_VERSION)
		throw new ClientError(
			'Query scoring requires a full-text wrapper with query API 8; the installed wrapper does not support scoring controls',
			400
		);
}
