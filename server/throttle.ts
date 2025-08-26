import logger from '../utility/logging/logger.js';
const MAX_EVENT_DELAY_TIME = 3000;
const DEFAULT_MAX_QUEUE_TIME = 20_000; // 20 seconds
let lastWarning = 0;
const WARNING_INTERVAL = 30000;
const EVENT_QUEUE_MONITORING_INTERVAL = 3000;
let lastEventQueueCheck = performance.now() + EVENT_QUEUE_MONITORING_INTERVAL;
let averageEventCycleTime = 0;
/**
 * Throttle function to limit the number of calls to a function so that the event queue doesn't get overwhelmed.
 * @param fn
 * @param onLimitExceeded
 * @param limit
 */
export function throttle(
	fn: (...args: any) => any,
	onLimitExceeded?: (...args: any) => any,
	maxQueueTimeLimit = DEFAULT_MAX_QUEUE_TIME
) {
	let queuedCalls: any[];
	return function (...args: any[]) {
		if (queuedCalls) {
			// this is an estimate of the time an event will take to process, based on the average event cycle time and the queue depth
			if (queuedCalls.length * averageEventCycleTime > maxQueueTimeLimit) {
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
			// get the decaying/running average of the event cycle time
			averageEventCycleTime = (averageEventCycleTime * 4 + now - startTime) / 5;
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
setInterval(() => {
	const now = performance.now();
	if (
		now - lastEventQueueCheck - EVENT_QUEUE_MONITORING_INTERVAL > MAX_EVENT_DELAY_TIME &&
		lastWarning + WARNING_INTERVAL < now
	) {
		logger.warn?.(
			`JavaScript execution has taken too long and is not allowing proper event queue cycling, consider using 'await new Promise(setImmediate)' in code that will execute for a long duration`
		);
		lastWarning = now;
	}
	lastEventQueueCheck = now;
}, EVENT_QUEUE_MONITORING_INTERVAL).unref();
