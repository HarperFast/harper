import { renameSync } from 'node:fs';

export type RenameRetryOptions = {
	retryBudgetMs?: number;
	maxRetries?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	onRetryExhausted?: (result: { code: string; attempts: number; elapsedMilliseconds: number }) => void;
	rename?: typeof renameSync;
};

export const RENAME_RETRY_BUDGET_MILLISECONDS = 3_630;
export const RENAME_RETRY_MAX_ATTEMPTS = 25;
export const RENAME_RETRY_INITIAL_DELAY_MILLISECONDS = 10;
export const RENAME_RETRY_MAX_DELAY_MILLISECONDS = 500;
const retrySleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function renameWithRetry(
	fromPath: string,
	toPath: string,
	{
		retryBudgetMs = RENAME_RETRY_BUDGET_MILLISECONDS,
		maxRetries = RENAME_RETRY_MAX_ATTEMPTS,
		initialDelayMs = RENAME_RETRY_INITIAL_DELAY_MILLISECONDS,
		maxDelayMs = RENAME_RETRY_MAX_DELAY_MILLISECONDS,
		onRetryExhausted,
		rename = renameSync,
	}: RenameRetryOptions = {}
): void {
	validateRenameRetryOptions({ retryBudgetMs, maxRetries, initialDelayMs, maxDelayMs });
	let retries = maxRetries;
	let delayMilliseconds = initialDelayMs;
	let retryDeadline: number | undefined;
	let finalAttempt = false;
	let attempts = 0;
	const startedAt = performance.now();
	while (true) {
		try {
			attempts++;
			rename(fromPath, toPath);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!finalAttempt && retries > 0 && retryable(code)) {
				retries--;
				retryDeadline ??= performance.now() + retryBudgetMs;
				const remainingBudgetMilliseconds = retryDeadline - performance.now();
				if (remainingBudgetMilliseconds > 0) {
					const sleepMilliseconds = Math.min(delayMilliseconds, remainingBudgetMilliseconds);
					finalAttempt = sleepMilliseconds === remainingBudgetMilliseconds;
					// This blocks the calling thread, but Atomics.wait yields to the OS instead of
					// spinning, which keeps a multi-second retry budget CPU-idle.
					if (sleepMilliseconds > 0) Atomics.wait(retrySleepBuffer, 0, 0, sleepMilliseconds);
					delayMilliseconds = Math.min(
						Math.max(delayMilliseconds * 2, RENAME_RETRY_INITIAL_DELAY_MILLISECONDS),
						maxDelayMs
					);
					continue;
				}
			}
			if (retryable(code))
				onRetryExhausted?.({
					code: code!,
					attempts,
					elapsedMilliseconds: Math.round(performance.now() - startedAt),
				});
			throw error;
		}
	}
}

function retryable(code: string | undefined): boolean {
	return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function validateRenameRetryOptions({
	retryBudgetMs = RENAME_RETRY_BUDGET_MILLISECONDS,
	maxRetries = RENAME_RETRY_MAX_ATTEMPTS,
	initialDelayMs = RENAME_RETRY_INITIAL_DELAY_MILLISECONDS,
	maxDelayMs = RENAME_RETRY_MAX_DELAY_MILLISECONDS,
}: RenameRetryOptions = {}): void {
	if (
		!Number.isFinite(retryBudgetMs) ||
		retryBudgetMs < 0 ||
		(!Number.isFinite(maxRetries) && maxRetries !== Infinity) ||
		maxRetries < 0 ||
		!Number.isFinite(initialDelayMs) ||
		initialDelayMs < 0 ||
		!Number.isFinite(maxDelayMs) ||
		maxDelayMs < 0
	)
		throw new RangeError('rename retry options must be non-negative numbers');
}
