// Why a lock that outlives the reader's budget is retried from a timer, and why both the bound and
// the backoff are wall clock rather than an attempt count: see "Root config watchers must read
// synchronously" in DESIGN.md (harper#2191).
const RETRY_BUDGET_MS = 3_100;
const INITIAL_DELAY_MS = 100;
const MAX_DELAY_MS = 1_600;

export class ConfigReadRetry {
	#timer?: NodeJS.Timeout;
	#deadline?: number;

	// `holdEventLoop` is for a caller whose boot barrier this ladder is the only thing left to
	// settle: an unref'd timer would let the thread drain and exit mid-boot instead.
	schedule(retry: () => void, holdEventLoop: boolean = false): boolean {
		this.cancel();
		const now = performance.now();
		this.#deadline ??= now + RETRY_BUDGET_MS;
		const remainingMs = this.#deadline - now;
		if (remainingMs <= 0) {
			this.reset();
			return false;
		}
		const elapsedMs = RETRY_BUDGET_MS - remainingMs;
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
