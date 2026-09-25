import { logger } from '../utility/logging/logger.ts';
import { Session, url as inspectorURL } from 'node:inspector';
const MAX_EVENT_DELAY_TIME = 3000;
const DEFAULT_MAX_QUEUE_TIME = 20_000; // 20 seconds
let lastWarning = 0;
const WARNING_INTERVAL = 30000;
const EVENT_QUEUE_MONITORING_INTERVAL = 3000;
const LIMIT_EXCEEDED_LOG_INTERVAL = 5000;
let lastLimitExceededLog = -Infinity;
let lastEventQueueCheck = performance.now() + EVENT_QUEUE_MONITORING_INTERVAL;
let averageEventCycleTime = 0;
/**
 * Throttle function to limit the number of calls to a function so that the event queue doesn't get overwhelmed.
 * @param fn
 * @param onLimitExceeded
 * @param maxQueueTimeLimit
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
				// Rate-limited: the shed itself is silent (a 503 the HTTP layer reports at most as an
				// analytics action), and without this line a burst of rejected writes leaves no
				// server-side record of the queue depth and event-loop cycle time that caused it.
				const now = performance.now();
				if (now - lastLimitExceededLog > LIMIT_EXCEEDED_LOG_INTERVAL) {
					lastLimitExceededLog = now;
					logger.warn?.(
						`Rejecting queued calls: ${queuedCalls.length} already queued at ~${Math.round(averageEventCycleTime)}ms per event cycle, an estimated wait past the ${maxQueueTimeLimit}ms limit`
					);
				}
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
		waitForNextCycle(performance.now());
		return fn(...args);
	};
	function waitForNextCycle(startTime: number) {
		setImmediate(() => {
			const now = performance.now();
			// get the decaying/running average of the event cycle time
			averageEventCycleTime = (averageEventCycleTime * 4 + now - startTime) / 5;
			const nextCall = queuedCalls.shift();
			if (nextCall) {
				const { fn: nextFunction } = nextCall;
				nextFunction();
				waitForNextCycle(now);
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

// Reset lastEventQueueCheck if we are resuming from the debugger
// so the event loop lag check ignores breakpoint pauses
setTimeout(() => {
	// wait for any debugger to register and then see if the inspector/debugger is actually enabled
	if (inspectorURL()) {
		const session = new Session();
		session.connect();
		session.post('Debugger.enable');
		session.on('inspectorNotification', ({ method }) => {
			if (method === 'Debugger.resumed') {
				// reset if we are resuming
				lastEventQueueCheck = performance.now();
			}
		});
	}
}, 1);
