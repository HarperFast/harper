import { logger } from '../utility/logging/logger.ts';
import { Session, url as inspectorURL } from 'node:inspector';
const MAX_EVENT_DELAY_TIME = 3000;
const DEFAULT_MAX_QUEUE_TIME = 20_000; // 20 seconds
let lastWarning = 0;
const WARNING_INTERVAL = 30000;
const EVENT_QUEUE_MONITORING_INTERVAL = 3000;
const LIMIT_EXCEEDED_LOG_INTERVAL = 5000;
let lastEventQueueCheck = performance.now() + EVENT_QUEUE_MONITORING_INTERVAL;
/**
 * Throttle function to limit the number of calls to a function so that the event queue doesn't get overwhelmed.
 * @param fn
 * @param onLimitExceeded
 * @param maxQueueTimeLimit
 */
export function throttle(
	fn: (...args: any) => any,
	onLimitExceeded?: (...args: any) => any,
	maxQueueTimeLimit = DEFAULT_MAX_QUEUE_TIME,
	name?: string
) {
	let queuedCalls: any[];
	// only cycles since this queue was last empty (server/DESIGN.md)
	let averageEventCycleTime = 0;
	let lastLimitExceededLog = -Infinity;
	return function (...args: any[]) {
		if (queuedCalls) {
			// this is an estimate of the time an event will take to process, based on the average event cycle time and the queue depth
			if (queuedCalls.length * averageEventCycleTime > maxQueueTimeLimit) {
				const now = performance.now();
				if (now - lastLimitExceededLog > LIMIT_EXCEEDED_LOG_INTERVAL) {
					lastLimitExceededLog = now;
					logger.warn?.(
						`Rejecting queued calls${name ? ` (${name})` : ''}: ${queuedCalls.length} already queued at ~${Math.round(averageEventCycleTime)}ms per event cycle, an estimated wait past the ${maxQueueTimeLimit}ms limit`
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
				averageEventCycleTime = 0;
			}
		});
	}
}
let loopProbePending = false;
let loopIterationStart = 0;
let callsSinceProbe = false;
function probeLoopIteration() {
	if (callsSinceProbe) {
		callsSinceProbe = false;
		loopIterationStart = performance.now();
		setImmediate(probeLoopIteration);
	} else loopProbePending = false;
}

export function rejectWhenLoopDelayed<A, B, R>(
	fn: (a: A, b: B) => R,
	onLimitExceeded: (a: A, b: B) => R,
	maxLoopDelay: number,
	name: string
) {
	let lastLimitExceededLog = -Infinity;
	return function (a: A, b: B): R {
		const now = performance.now();
		callsSinceProbe = true;
		if (!loopProbePending) {
			loopProbePending = true;
			loopIterationStart = now;
			setImmediate(probeLoopIteration);
		} else if (now - loopIterationStart > maxLoopDelay) {
			if (now - lastLimitExceededLog > LIMIT_EXCEEDED_LOG_INTERVAL) {
				lastLimitExceededLog = now;
				logger.warn?.(
					`Rejecting calls (${name}): the event loop has been busy for ~${Math.round(now - loopIterationStart)}ms, past the ${maxLoopDelay}ms limit`
				);
			}
			return onLimitExceeded(a, b);
		}
		return fn(a, b);
	};
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
				lastEventQueueCheck = loopIterationStart = performance.now();
			}
		});
	}
}, 1);
