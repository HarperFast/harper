import { isMainThread, parentPort, threadId } from 'worker_threads';
import { messageTypeListener } from '../server/threads/manageThreads';
import { table } from './tableLoader';
import { getLogFilePath } from '../utility/logging/harper_logger';
import { dirname, join } from 'path';
import { open, appendFile, readFile, writeFile } from 'fs/promises';
let active_actions = new Map<string, number[] & { occurred: number; count: number }>();

/**
 * When an HTTP request (or any other type) is made, we record it here for analytics
 * @param path
 * @param value
 */
export function recordAction(path, value) {
	// TODO: We may want to consider sampling a subset of queries if this has too high of overhead. It is primarily the sort operation that is expensive (computing median, p96, etc.)
	let action = active_actions.get(path);
	if (action) action.push(value);
	else {
		action = [value];
		active_actions.set(path, action);
	}
	if (!analytics_start) sendAnalytics();
}
export function recordActionBinary(path, value) {
	let action = active_actions.get(path);
	if (!action)
		active_actions.set(
			path,
			(action = {
				occurred: 0,
				count: 0,
			})
		);
	if (value) action.occurred++;
	action.count++;
	if (!analytics_start) sendAnalytics();
}
let analytics_start = 0;
const ANALYTICS_DELAY = 2000;
const ANALYTICS_REPORT_TYPE = 'analytics-report';

/**
 * Periodically send analytics data back to the main thread for storage
 */
function sendAnalytics() {
	analytics_start = performance.now();
	setTimeout(() => {
		const period = performance.now() - analytics_start;
		analytics_start = 0;
		const report = {
			time: Date.now(),
			threadId,
		};
		for (const [name, value] of active_actions) {
			if (value.sort) {
				value.sort();
				const count = value.length;
				// compute the stats
				report[name] = {
					median: value[count >> 1],
					p95: value[Math.floor(count * 0.95)],
					p90: value[Math.floor(count * 0.9)],
					count,
					period,
				};
			} else {
				report[name] = value;
			}
		}
		active_actions = new Map();
		// TODO: We could actually make this a fair bit more efficient by using a SharedArrayBuffer and each time
		//  reserializing into the same SAB.
		parentPort?.postMessage({
			type: ANALYTICS_REPORT_TYPE,
			report,
		});
	}, ANALYTICS_DELAY).unref();
}
if (isMainThread) {
	const AnalyticsTable = table({
		table: 'hdb_analytics',
		database: 'system',
		expiration: 864000,
		attributes: [
			{
				name: 'time',
				isPrimaryKey: true,
			},
			{
				name: 'action',
				indexed: true,
			},
			{
				name: 'values',
			},
		],
	});
	messageTypeListener(ANALYTICS_REPORT_TYPE, (message) => {
		const report = message.report;
		AnalyticsTable.put(report.time, report);
		last_append = logAnalytics(report);
		console.log(message);
	});
}
let last_append;
let analytics_log;
const MAX_ANALYTICS_SIZE = 1000000;
async function logAnalytics(report) {
	await last_append;
	if (!analytics_log) {
		const log_dir = dirname(getLogFilePath());
		try {
			analytics_log = await open(join(log_dir, 'analytics.log'), 'r+');
		} catch (error) {
			analytics_log = await open(join(log_dir, 'analytics.log'), 'w+');
		}
	}
	let position = (await analytics_log.stat()).size;
	if (position > MAX_ANALYTICS_SIZE) {
		let contents = Buffer.alloc(position);
		await analytics_log.read(contents, { position: 0 });
		contents = contents.subarray(contents.indexOf(10, contents.length / 2) + 1); // find a carriage return to break on after the halfway point
		await analytics_log.write(contents, { position: 0 });
		await analytics_log.truncate(contents.length);
		position = contents.length;
	}
	await analytics_log.write(JSON.stringify(report) + '\n', position);
}
