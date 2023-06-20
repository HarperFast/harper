import { isMainThread, parentPort, threadId } from 'worker_threads';
import { messageTypeListener, getThreadInfo } from '../server/threads/manageThreads';
import { table } from './databases';
import { getLogFilePath } from '../utility/logging/harper_logger';
import { dirname, join } from 'path';
import { open, appendFile, readFile, writeFile } from 'fs/promises';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';

let active_actions = new Map<string, number[] & { occurred: number; count: number }>();
let analytics_enabled = true;
export function setAnalyticsEnabled(enabled) {
	analytics_enabled = enabled;
}
/**
 * Record an action for analytics (like an HTTP request, replication, MQTT message)
 * @param path
 * @param value
 */
export function recordAction(value, metric, path?, method?, type?) {
	if (!analytics_enabled) return;
	// TODO: We may want to consider sampling a subset of queries if this has too high of overhead. It is primarily the sort operation that is expensive (computing median, p96, etc.)
	let key = metric + '-' + path;
	if (method) key += '-' + method;
	let action = active_actions.get(key);
	if (action) {
		action.push(value);
		action.total += value;
	} else {
		action = [value];
		action.total = value;
		action.description = {
			metric,
			path,
			method,
			type,
		};
		active_actions.set(key, action);
	}
	if (!analytics_start) sendAnalytics();
}
export function recordActionBinary(value, metric, path, method, type?) {
	recordAction(value ? 1 : 0, metric, path, method, type);
}
let analytics_start = 0;
const ANALYTICS_DELAY = 1000;
const ANALYTICS_REPORT_TYPE = 'analytics-report';
const analytics_listeners = [];
export function addAnalyticsListener(callback) {
	analytics_listeners.push(callback);
}
/**
 * Periodically send analytics data back to the main thread for storage
 */
function sendAnalytics() {
	analytics_start = performance.now();
	setTimeout(() => {
		const period = performance.now() - analytics_start;
		analytics_start = 0;
		const metrics = [];
		const report = {
			time: Date.now(),
			period,
			threadId,
			metrics,
		};
		for (const [name, value] of active_actions) {
			if (value.sort) {
				value.sort();
				const count = value.length;
				// compute the stats
				metrics.push(
					Object.assign(value.description, {
						median: value[count >> 1],
						mean: value.total / count,
						p95: value[Math.floor(count * 0.95)],
						p90: value[Math.floor(count * 0.9)],
						count,
					})
				);
			} else {
				metrics.push(value);
			}
		}
		const memory_usage = process.memoryUsage();
		metrics.push({
			metric: 'memory',
			threadId,
			...memory_usage,
		});
		for (const listener of analytics_listeners) {
			listener(metrics);
		}
		active_actions = new Map();
		if (parentPort)
			parentPort.postMessage({
				type: ANALYTICS_REPORT_TYPE,
				report,
			});
		else recordAnalytics({ report });
	}, ANALYTICS_DELAY).unref();
}
const AGGREGATE_PREFIX = 'min-'; // we could have different levels of aggregation, but this denotes hourly aggregation
async function aggregation(from_period, to_period = 60000) {
	const AnalyticsTable = getAnalyticsTable();
	let last_for_period;
	// find the last entry for this period
	for (const entry of AnalyticsTable.primaryStore.getRange({ start: AGGREGATE_PREFIX + 'z', reverse: true })) {
		if (!entry.value) continue;
		last_for_period = entry.value.time;
		break;
	}
	// is it older than the period we are calculating?
	if (Date.now() - to_period < last_for_period) return;
	let first_for_period;
	const aggregate_actions = new Map();
	let last_time;
	for (const { key, value } of AnalyticsTable.primaryStore.getRange({
		start: last_for_period || false,
		end: Infinity,
	})) {
		if (!value) continue;
		if (first_for_period) {
			if (key > first_for_period + to_period) break; // outside the period of interest
		} else first_for_period = key;
		last_time = key;
		const { metrics } = value;
		for (const entry of metrics) {
			let { path, method, type, metric, count, ...measures } = entry;
			if (!count) count = 1;
			let key = metric + '-' + path;
			if (method) key += '-' + method;
			let action = aggregate_actions.get(key);
			if (action) {
				for (const measure_name in measures) {
					const value = measures[measure_name];
					if (typeof value === 'number') {
						const action_count = action.count || 1;
						action[measure_name] =
							(action[measure_name] * action_count + value * count) / (action.count = action_count + count);
					}
				}
			} else {
				action = Object.assign({ period: to_period }, entry);
				aggregate_actions.set(key, action);
			}
		}
		await rest();
	}
	for (const [key, value] of aggregate_actions) {
		value.id = AGGREGATE_PREFIX + last_time + '-' + key;
		AnalyticsTable.put(value);
	}
}

const rest = () => new Promise(setImmediate);

async function cleanup(expiration, period) {
	const AnalyticsTable = getAnalyticsTable();
	const end = Date.now() - expiration;
	for (const { key, value } of AnalyticsTable.primaryStore.getKeys({ start: false, end })) {
		if (value) AnalyticsTable.delete(key);
	}
}

const AGGREGATE_PERIOD = 20000;
const RAW_EXPIRATION = 3600000;
const AGGREGATE_EXPIRATION = 100000;
let AnalyticsTable;
function getAnalyticsTable() {
	return (
		AnalyticsTable ||
		(AnalyticsTable = table({
			table: 'hdb_analytics',
			database: 'system',
			expiration: 864000,
			attributes: [
				{
					name: 'id',
					isPrimaryKey: true,
				},
				{
					name: 'action',
				},
				{
					name: 'values',
				},
			],
		}))
	);
}
if (isMainThread) {
	messageTypeListener(ANALYTICS_REPORT_TYPE, recordAnalytics);
	setInterval(async () => {
		await aggregation(ANALYTICS_DELAY, AGGREGATE_PERIOD);
		await cleanup(RAW_EXPIRATION, ANALYTICS_DELAY);
		//await cleanup(AGGREGATE_EXPIRATION, AGGREGATE_PERIOD);
	}, AGGREGATE_PERIOD / 2).unref();
}
let total_bytes_processed = 0;
const last_utilizations = new Map();
function recordAnalytics(message, worker?) {
	const report = message.report;
	report.threadId = worker?.threadId || threadId;
	// Add system information stats as well
	for (const metric of report.metrics) {
		if (metric.metric === 'bytes-sent') {
			total_bytes_processed += metric.mean * metric.count;
		}
	}
	report.totalBytesProcessed = total_bytes_processed;
	if (worker) {
		report.metrics.push({
			metric: 'utilization',
			...worker.performance.eventLoopUtilization(last_utilizations.get(worker)),
		});
		last_utilizations.set(worker, worker.performance.eventLoopUtilization());
	}
	report.id = getNextMonotonicTime();
	getAnalyticsTable().put(report);
	last_append = logAnalytics(report);
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
