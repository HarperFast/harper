import { readFileSync } from 'node:fs';

// Why root config reads must not be async, and why this budget is shared rather than per call:
// see "Root config watchers must read synchronously" in DESIGN.md (harper#2191).
const READ_RETRY_BUDGET_MS = 500;
const READ_RETRY_INITIAL_DELAY_MS = 10;
const READ_RETRY_MAX_DELAY_MS = 100;
const readRetrySleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const retryDeadlines = new Map<string, number>();

// A caller that already owns a retry ladder passes `waitForLock` false, so one lock costs one
// blocking window in total rather than one per rung.
export function readConfigFileSync(filePath: string, waitForLock: boolean = true): string {
	let delayMs = READ_RETRY_INITIAL_DELAY_MS;
	while (true) {
		try {
			const contents = readFileSync(filePath, 'utf-8');
			retryDeadlines.delete(filePath);
			return contents;
		} catch (error) {
			const remainingBudgetMs = waitForLock && isSharingViolation(error) ? remainingRetryBudgetMs(filePath) : 0;
			if (remainingBudgetMs <= 0) throw error;
			Atomics.wait(readRetrySleepBuffer, 0, 0, Math.min(delayMs, remainingBudgetMs));
			delayMs = Math.min(delayMs * 2, READ_RETRY_MAX_DELAY_MS);
		}
	}
}

function isSharingViolation(error: unknown): boolean {
	if (process.platform !== 'win32') return false;
	const code = (error as { code?: string } | null)?.code;
	return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function remainingRetryBudgetMs(filePath: string): number {
	const now = performance.now();
	let deadline = retryDeadlines.get(filePath);
	// A deadline more than one budget past its expiry belongs to an earlier burst, not this one.
	if (deadline === undefined || now - deadline > READ_RETRY_BUDGET_MS) {
		deadline = now + READ_RETRY_BUDGET_MS;
		retryDeadlines.set(filePath, deadline);
	}
	return deadline - now;
}
