import { steadyClockNow } from '@harperfast/rocksdb-js';
import { DEFAULT_FULL_TEXT_SEARCH_LIMITS, type FullTextSearchLimits } from './fullTextSearchLimits.ts';

export function fullTextContinuationNow(): bigint {
	const milliseconds = steadyClockNow();
	const whole = Math.trunc(milliseconds);
	return BigInt(whole) * 1_000_000n + BigInt(Math.round((milliseconds - whole) * 1_000_000));
}

export function fullTextContinuationDeadline(policy: FullTextSearchLimits = DEFAULT_FULL_TEXT_SEARCH_LIMITS): bigint {
	return fullTextContinuationNow() + BigInt(policy.requestBudgetMilliseconds) * 1_000_000n;
}
