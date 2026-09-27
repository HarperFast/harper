export const FULL_TEXT_QUERY_PAUSE_OPERATION = 'pause-full-text-query-readers';
export const FULL_TEXT_QUERY_RESUME_OPERATION = 'resume-full-text-query-readers';

export const FULL_TEXT_COMPARATORS = [
	'matches',
	'matches_all',
	'matches_phrase',
	'matches_prefix',
	'matches_fuzzy',
	'matches_fuzzy_prefix',
	'not_matches',
	'not_matches_all',
	'not_matches_phrase',
	'not_matches_prefix',
	'not_matches_fuzzy',
	'not_matches_fuzzy_prefix',
] as const;
