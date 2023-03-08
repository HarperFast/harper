import { isMainThread, parentPort, threadId } from 'worker_threads';
import { messageTypeListener } from '../server/threads/manageThreads';
import { databases } from './database';
let active_actions = new Map<string, number[]>();

/**
 * When an HTTP request (or any other type) is made, we record it here for analytics
 * @param path
 * @param timing
 */
export function recordRequest(path, timing) {
	let action = active_actions.get(path);
	if (action)
		action.push(timing);
	else {
		action = [timing];
		active_actions.set(path, action);
	}
	if (!analytics_start)
		sendAnalytics();
}
let analytics_start = 0;
const ANALYTICS_DELAY = 10000;
const ANALYTICS_REPORT_TYPE = 'analytics-report';

/**
 * Periodically send analytics data back to the main thread for storage
 */
function sendAnalytics() {
	analytics_start = performance.now();
	setTimeout(() => {
		let duration = performance.now() - analytics_start;
		analytics_start = 0;
		let report = {
			type: ANALYTICS_REPORT_TYPE,
			created: Date.now(),
			threadId,
		};
		for (let [ name, value ] of active_actions) {
			if (typeof value === 'object') {
				value.sort();
				let count = value.length;
				// compute the stats
				report[name] = {
					median: value[count >> 1],
					p95: value[Math.floor(count * 0.95)],
					p90: value[Math.floor(count * 0.90)],
					count,
					duration
				};
			}
		}
		active_actions = new Map();
		// TODO: We could actually make this a fair bit more efficient by using a SharedArrayBuffer and each time
		//  reserializing into the same SAB.
		parentPort.postMessage(report);
	}, ANALYTICS_DELAY).unref();
}
if (isMainThread) {
	messageTypeListener(ANALYTICS_REPORT_TYPE, (message) => {
		/*let analytics = new databases.system.analytics();
		analytics.put(message.created, message);*/
		//console.log(message);
	});
}

export function trackAction(name, action) {
	let action_tracking = active_actions.get(name);
	let start_time = performance.now();
	return action().finally(() => {
		let duration = performance.now();
	});
}
