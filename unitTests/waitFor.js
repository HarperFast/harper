const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

/**
 * Poll `condition` until it returns a truthy value instead of sleeping for a fixed
 * duration and then asserting that an async side effect has landed. Fixed `delay(N)`
 * waits race against loaded CI runners; waiting for the actual condition does not.
 *
 * `condition` may be synchronous or return a promise — both are awaited each poll.
 * Resolves with the (truthy) condition result so callers can use it; fails the test
 * via `assert.fail` if `timeout` ms elapse before the condition is met.
 *
 * @param {() => unknown | Promise<unknown>} condition evaluated immediately, then every `interval` ms
 * @param {number | { timeout?: number, interval?: number, message?: string }} [timeoutOrOptions]
 *   a timeout in ms, or an options object. `message` is used as the failure message on timeout.
 * @param {number} [interval] poll interval in ms, used only when `timeoutOrOptions` is a number
 *   (preserves the original `waitFor(condition, timeout, interval)` signature)
 * @returns {Promise<unknown>} the truthy value `condition` returned
 */
async function waitFor(condition, timeoutOrOptions = {}, interval) {
	const options = typeof timeoutOrOptions === 'number' ? { timeout: timeoutOrOptions, interval } : timeoutOrOptions;
	const { timeout = 2000, interval: pollInterval = 10, message } = options;
	const deadline = Date.now() + timeout;
	let result = await condition();
	while (!result) {
		if (Date.now() >= deadline) {
			assert.fail(message ?? `Timed out after ${timeout}ms waiting for condition`);
		}
		await sleep(pollInterval);
		result = await condition();
	}
	return result;
}

module.exports = { waitFor };
