import logger from '../utility/logging/logger.js';
const MAX_EVENT_TURN_TIME = 1000;
const DEFAULT_MAX_QUEUE = 20;
const lastWarning = 0;
const WARNING_INTERVAL = 30000;
/**
 * Throttle function to limit the number of calls to a function so that the event queue doesn't get overwhelmed.
 * @param fn
 * @param onLimitExceeded
 * @param limit
 */
export function throttle(
	fn: (...args: any) => any,
	onLimitExceeded?: (...args: any) => any,
	getSourceDescription?: (...args: any) => any,
	limit = DEFAULT_MAX_QUEUE
) {
	let queuedCalls: any[];
	return function (...args: any[]) {
		if (queuedCalls) {
			if (queuedCalls.length > limit) {
				return onLimitExceeded(...args);
			}
			return new Promise((resolve, reject) => {
				queuedCalls.push({
					args,
					fn() {
						try {
							const result = fn(...args);
							resolve(result);
						} catch (e) {
							reject(e);
						}
					},
				});
			});
		}
		queuedCalls = [];
		waitForNextCycle(performance.now(), args);
		return fn(...args);
	};
	function waitForNextCycle(startTime: number, args: any) {
		setImmediate(() => {
			const now = performance.now();
			if (now - startTime > MAX_EVENT_TURN_TIME && lastWarning + WARNING_INTERVAL < now) {
				logger.warn?.(
					`JavaScript execution has taken too long and is not allowing proper event queue cycling ${getSourceDescription?.(...args) ?? ''}, consider using 'await new Promise(setImmediate)' in code that will execute for a long duration`
				);
			}
			const nextCall = queuedCalls.shift();
			if (nextCall) {
				const { args: nextArgs, fn: nextFunction } = nextCall;
				nextFunction();
				waitForNextCycle(now, nextArgs);
			} else {
				queuedCalls = null;
			}
		});
	}
}
