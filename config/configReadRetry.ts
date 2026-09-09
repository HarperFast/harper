// Why a lock that outlives the reader's budget is retried from a timer, and why both the bound and
// the backoff are wall clock rather than an attempt count: see "Root config watchers must read
// synchronously" in DESIGN.md (harper#2191).
const RETRY_BUDGET_MS = 3_100;
const INITIAL_DELAY_MS = 100;
const MAX_DELAY_MS = 1_600;

let retryBudgetMs = RETRY_BUDGET_MS;

// Test-only, the read-side twin of `atomicWriteFile`'s `retryBudgetMs` option. A case that only
// needs the ladder *spent* has no way to get there but wall clock, so without this each one sits
// out the shipped 3.1 s; a dozen of them cost the unit job 40 s. Called with no argument it
// restores the shipped value, and `configReadRetry.test.js` still spends that value in full, so
// shortening it elsewhere cannot hide a change to what ships.
export function _setRetryBudgetForTests(ms: number = RETRY_BUDGET_MS): void {
	retryBudgetMs = ms;
}

export function _retryBudgetForTests(): number {
	return retryBudgetMs;
}

export class ConfigReadRetry {
	#timer?: NodeJS.Timeout;
	#deadline?: number;
	// Captured with the deadline: the backoff is a fraction of the budget the deadline came from,
	// so reading the module value again mid-ladder would mis-scale it if a test had changed it.
	#budgetMs: number = retryBudgetMs;

	// `holdEventLoop` is for a caller whose boot barrier this ladder is the only thing left to
	// settle: an unref'd timer would let the thread drain and exit mid-boot instead.
	schedule(retry: () => void, holdEventLoop: boolean = false): boolean {
		this.cancel();
		const now = performance.now();
		if (this.#deadline === undefined) {
			this.#budgetMs = retryBudgetMs;
			this.#deadline = now + this.#budgetMs;
		}
		const remainingMs = this.#deadline - now;
		if (remainingMs <= 0) {
			this.reset();
			return false;
		}
		const elapsedMs = this.#budgetMs - remainingMs;
		const delayMs = Math.min(Math.max(elapsedMs, INITIAL_DELAY_MS), MAX_DELAY_MS, remainingMs);
		this.#timer = setTimeout(retry, delayMs);
		if (!holdEventLoop) this.#timer.unref();
		return true;
	}

	get pending(): boolean {
		return this.#timer !== undefined;
	}

	reset(): void {
		this.cancel();
		this.#deadline = undefined;
	}

	cancel(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}
