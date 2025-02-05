import { parentPort, threadId } from 'worker_threads';
import { setChildListenerByType } from '../server/threads/manageThreads';
import { getDatabases, table } from './databases';
import type { Databases, Table, Tables } from './databases';
import { getLogFilePath } from '../utility/logging/harper_logger';
import { loggerWithTag } from '../utility/logging/logger';
import { dirname, join } from 'path';
import { open } from 'fs/promises';
import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { get as env_get, initSync } from '../utility/environment/environmentManager';
import { CONFIG_PARAMS } from '../utility/hdbTerms';
import { server } from '../server/Server';
import fs from 'node:fs';

const log = loggerWithTag('analytics');

initSync();

type ActionCallback = (action: Action) => void;
export type Value = number | boolean | ActionCallback;
interface Action {
	total?: number;
	values?: Float32Array;
	count?: number;
	callback?: ActionCallback;
	description?: {
		metric: string;
		path: string;
		method: string;
		type: string;
	};
}

let active_actions = new Map<string, Action>();
let analytics_enabled = env_get(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1;

export function setAnalyticsEnabled(enabled: boolean) {
	analytics_enabled = enabled;
}

function recordExistingAction(value: Value, action: Action) {
	if (typeof value === 'number') {
		let values: Float32Array = action.values;
		const index = values.index++;
		if (index >= values.length) {
			const old_values = values;
			action.values = values = new Float32Array(index * 2);
			values.set(old_values);
			values.index = index + 1;
		}
		values[index] = value;
		action.total += value;
	} else if (typeof value === 'boolean') {
		if (value) action.total++;
		action.count++;
	} else if (typeof value === 'function') {
		// nothing to do except wait for the callback
		action.count++;
	} else throw new TypeError('Invalid metric value type ' + typeof value);
}

function recordNewAction(key: string, value: Value, metric?: string, path?: string, method?: string, type?: string) {
	const action: Action = {};
	if (typeof value === 'number') {
		action.total = value;
		action.values = new Float32Array(4);
		action.values.index = 1;
		action.values[0] = value;
		action.total = value;
	} else if (typeof value === 'boolean') {
		action.total = value ? 1 : 0;
		action.count = 1;
	} else if (typeof value === 'function') {
		action.count = 1;
		action.callback = value;
	} else {
		throw new TypeError('Invalid metric value type ' + typeof value);
	}
	action.description = {
		metric,
		path,
		method,
		type,
	};
	active_actions.set(key, action);
}

/**
 * Record an action for analytics (like an HTTP request, replication, MQTT message)
 * @param value
 * @param metric
 * @param path
 * @param method
 * @param type
 */
export function recordAction(value: Value, metric: string, path?: string, method?: string, type?: string) {
	if (!analytics_enabled) return;
	// TODO: May want to consider nested paths, as they may yield faster hashing of (fixed) strings that hashing concatenated strings
	let key = metric + (path ? '-' + path : '');
	if (method !== undefined) key += '-' + method;
	if (type !== undefined) key += '-' + type;
	const action = active_actions.get(key);
	if (action) {
		recordExistingAction(value, action);
	} else {
		recordNewAction(key, value, metric, path, method, type);
	}
	if (!analytics_start) sendAnalytics();
}

server.recordAnalytics = recordAction;

export function recordActionBinary(value, metric, path?, method?, type?) {
	recordAction(Boolean(value), metric, path, method, type);
}

let analytics_start = 0;
const ANALYTICS_DELAY = 1000;
const ANALYTICS_REPORT_TYPE = 'analytics-report';
const analytics_listeners = [];

export function addAnalyticsListener(callback) {
	analytics_listeners.push(callback);
}

const IDEAL_PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1];

/**
 * Periodically send analytics data back to the main thread for storage
 */
function sendAnalytics() {
	analytics_start = performance.now();
	setTimeout(async () => {
		const period = performance.now() - analytics_start;
		analytics_start = 0;
		const metrics = [];
		const report = {
			time: Date.now(),
			period,
			threadId,
			metrics,
		};
		for (const [name, action] of active_actions) {
			if (action.values) {
				const values = action.values.subarray(0, action.values.index);
				values.sort();
				const count = values.length;
				// compute the stats
				let last_upper_bound = 0;
				const distribution = [];
				let last_value;
				for (const percentile of IDEAL_PERCENTILES) {
					const upper_bound = Math.floor(count * percentile);
					const value = values[upper_bound - 1];
					if (upper_bound > last_upper_bound) {
						const count = upper_bound - last_upper_bound;
						if (value === last_value) {
							const entry = distribution[distribution.length - 1];
							if (typeof entry === 'number') distribution[distribution.length - 1] = { value: entry, count: 1 + count };
							else entry.count += count;
						} else {
							distribution.push(count > 1 ? { value, count } : value);
							last_value = value;
						}
						last_upper_bound = upper_bound;
					}
				}
				metrics.push(
					Object.assign(action.description, {
						mean: action.total / count,
						distribution,
						count,
					})
				);
			} else if (action.callback) {
				metrics.push(Object.assign(action.description, action.callback(action)));
			} else {
				metrics.push(
					Object.assign(action.description, {
						total: action.total,
						count: action.count,
					})
				);
			}
			await rest(); // sort's are expensive and we don't want to do two of them in the same event turn
		}
		const memory_usage = process.memoryUsage();
		metrics.push({
			metric: 'memory',
			threadId,
			byThread: true,
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

interface Metric {
	[key: string]: any;
}

function storeMetric(table: Table, metricName: string, metric: Metric) {
	const metricValue = {
		id: getNextMonotonicTime(),
		metric: metricName,
		...metric,
	};
	table.primaryStore.put(metricValue.id, metricValue, { append: true }).then((success: boolean) => {
		if (!success) {
			table.primaryStore.put(metricValue.id, metricValue);
		}
	});
}

interface ResourceUsage extends Partial<NodeJS.ResourceUsage> {
	time?: number;
	period?: number;
	cpuUtilization?: number;
}

/** calculateCPUUtilization takes a ResourceUsage with at least userCPUTime & systemCPUTime set
 *  with millisecond values (NB: Node's process.resourceUsage returns values in microseconds for
 *  these fields so divide them by 1000 to get milliseconds) and a time period in milliseconds
 *  and returns the percentage of that time the CPU was being utilized as a decimal value
 *  between 0 and 1. So for example, 50% utilization will be returned as 0.5.
 */
export function calculateCPUUtilization(resourceUsage: ResourceUsage, period: number): number {
	const cpuTime = resourceUsage.userCPUTime + resourceUsage.systemCPUTime;
	return Math.round((cpuTime / period) * 100) / 100;
}

/** diffResourceUsage takes a ResourceUsage representing the last time we stored them and a new
 *  process.resourceUsage() return value and normalizes and diffs the two values to return the
 *  new values for this time period.
 */
export function diffResourceUsage(
	lastResourceUsage: ResourceUsage,
	resourceUsage: NodeJS.ResourceUsage
): ResourceUsage {
	return {
		// Node returns userCPUTime & systemCPUTime as microseconds, so normalize to milliseconds first
		userCPUTime: resourceUsage.userCPUTime / 1000 - (lastResourceUsage?.userCPUTime ?? 0),
		systemCPUTime: resourceUsage.systemCPUTime / 1000 - (lastResourceUsage?.systemCPUTime ?? 0),
		minorPageFault: resourceUsage.minorPageFault - (lastResourceUsage?.minorPageFault ?? 0),
		majorPageFault: resourceUsage.majorPageFault - (lastResourceUsage?.majorPageFault ?? 0),
		fsRead: resourceUsage.fsRead - (lastResourceUsage?.fsRead ?? 0),
		fsWrite: resourceUsage.fsWrite - (lastResourceUsage?.fsWrite ?? 0),
		voluntaryContextSwitches:
			resourceUsage.voluntaryContextSwitches - (lastResourceUsage?.voluntaryContextSwitches ?? 0),
		involuntaryContextSwitches:
			resourceUsage.involuntaryContextSwitches - (lastResourceUsage?.involuntaryContextSwitches ?? 0),
	};
}

/** storeTableSizeMetrics returns the cumulative size of the tables
 */
function storeTableSizeMetrics(analyticsTable: Table, dbName: string, tables: Tables): number {
	let dbUsedSize = 0;
	for (const [tableName, table] of Object.entries(tables)) {
		const fullTableName = `${dbName}.${tableName}`;
		const tableSize = table.getSize();
		const metric = {
			database: dbName,
			table: tableName,
			size: tableSize,
		};
		log.debug?.(`table ${fullTableName} size metric: ${JSON.stringify(metric)}`);
		storeMetric(analyticsTable, 'table-size', metric);
		dbUsedSize += tableSize;
	}
	return dbUsedSize;
}

function storeDBSizeMetrics(analyticsTable: Table, databases: Databases) {
	for (const [db, tables] of Object.entries(databases)) {
		const [firstTable] = Object.values(tables);
		const dbAuditSize = firstTable.getAuditSize();
		const dbTotalSize = fs.statSync(firstTable.primaryStore.env.path).size;
		const dbUsedSize = storeTableSizeMetrics(analyticsTable, db, tables);
		const dbFree = dbTotalSize - dbUsedSize;
		const metric = {
			database: db,
			size: dbTotalSize,
			used: dbUsedSize,
			free: dbFree,
			audit: dbAuditSize,
		};
		log.debug?.(`database ${db} size metric: ${JSON.stringify(metric)}`);
		storeMetric(analyticsTable, 'database-size', metric);
	}
}

async function aggregation(from_period, to_period = 60000) {
	const raw_analytics_table = getRawAnalyticsTable();
	const analytics_table = getAnalyticsTable();
	const task_queue_latency = new Promise((resolve) => {
		let start = performance.now();
		setImmediate(() => {
			const now = performance.now();
			if (now - start > 5000)
				log.warn?.('Unusually high event queue latency on the main thread of ' + Math.round(now - start) + 'ms');
			start = performance.now(); // We use this start time to measure the time it actually takes to on the task queue, minus the time on the event queu
		});
		analytics_table.primaryStore.prefetch([1], () => {
			const now = performance.now();
			if (now - start > 5000)
				log.warn?.('Unusually high task queue latency on the main thread of ' + Math.round(now - start) + 'ms');
			resolve(now - start);
		});
	});
	let last_for_period;
	// find the last entry for this period
	for (const entry of analytics_table.primaryStore.getRange({
		start: Infinity,
		end: false,
		reverse: true,
	})) {
		if (!entry.value?.time) continue;
		last_for_period = entry.value.time;
		break;
	}
	// was the last aggregation too recent to calculate a whole period?
	if (Date.now() - to_period < last_for_period) return;
	let first_for_period;
	const aggregate_actions = new Map();
	const distributions = new Map();
	const threads_to_average = [];
	let last_time: number;
	for (const { key, value } of raw_analytics_table.primaryStore.getRange({
		start: last_for_period || false,
		exclusiveStart: true,
		end: Infinity,
	})) {
		if (!value) continue;
		if (first_for_period) {
			if (key > first_for_period + to_period) break; // outside the period of interest
		} else first_for_period = key;
		last_time = key;
		const { metrics, threadId } = value;
		for (const entry of metrics || []) {
			let { path, method, type, metric, count, total, distribution, threads, ...measures } = entry;
			if (!count) count = 1;
			let key = metric + (path ? '-' + path : '');
			if (method !== undefined) key += '-' + method;
			if (type !== undefined) key += '-' + type;
			let action = aggregate_actions.get(key);
			if (action) {
				if (action.threads) {
					const action_for_thread = action.threads[threadId];
					if (action_for_thread) action = action_for_thread;
					else {
						action.threads[threadId] = { ...measures };
						continue;
					}
				}
				if (!action.count) action.count = 1;
				const previous_count = action.count;
				for (const measure_name in measures) {
					const value = measures[measure_name];
					if (typeof value === 'number') {
						action[measure_name] = (action[measure_name] * previous_count + value * count) / (previous_count + count);
					}
				}
				action.count += count;
				if (total >= 0) {
					action.total += total;
					action.ratio = action.total / action.count;
				}
			} else {
				action = { period: to_period, ...entry };
				delete action.distribution;
				aggregate_actions.set(key, action);
				if (action.byThread) {
					action.threads = [];
					action.threads[threadId] = { ...measures };
					threads_to_average.push(action);
				}
			}
			if (distribution) {
				distribution = distribution.map((entry) => (typeof entry === 'number' ? { value: entry, count: 1 } : entry));
				const existing_distribution = distributions.get(key);
				if (!existing_distribution) distributions.set(key, distribution);
				else {
					existing_distribution.push(...distribution);
				}
			}
		}
		await rest();
	}
	for (const entry of threads_to_average) {
		let { path, method, type, metric, count, total, distribution, threads, ...measures } = entry;
		threads = threads.filter((thread) => thread);
		for (const measure_name in measures) {
			if (typeof entry[measure_name] !== 'number') continue;
			let total = 0;
			for (const thread of threads) {
				const value = thread[measure_name];
				if (typeof value === 'number') {
					total += value;
				}
			}
			entry[measure_name] = total;
		}
		entry.count = threads.length;
		delete entry.threads;
		delete entry.byThread;
	}
	for (const [key, distribution] of distributions) {
		// now iterate through the distributions finding the close bin to each percentile and interpolating the position in that bin
		const action = aggregate_actions.get(key);
		distribution.sort((a, b) => (a.value > b.value ? 1 : -1));
		const count = action.count - 1;
		const percentiles = [];
		let count_position = 0;
		let index = 0;
		let bin;
		for (const percentile of IDEAL_PERCENTILES) {
			const next_target_count = count * percentile;
			while (count_position < next_target_count) {
				bin = distribution[index++];
				count_position += bin.count;
				// we decrement these counts so we are skipping the minimum value in our interpolation
				if (index === 1) count_position--;
			}
			const previous_bin = distribution[index > 1 ? index - 2 : 0];
			if (!bin) bin = distribution[0];
			percentiles.push(
				bin.value - ((bin.value - previous_bin.value) * (count_position - next_target_count)) / bin.count
			);
		}
		const [p1, p10, p25, median, p75, p90, p95, p99, p999] = percentiles;
		Object.assign(action, { p1, p10, p25, median, p75, p90, p95, p99, p999 });
	}
	let has_updates;
	for (const [key, value] of aggregate_actions) {
		value.id = getNextMonotonicTime();
		value.time = last_time;
		analytics_table.primaryStore.put(value.id, value, { append: true }).then((success: boolean) => {
			// if for some reason we can't append, try again without append
			if (!success) {
				analytics_table.primaryStore.put(value.id, value);
			}
		});
		has_updates = true;
	}
	const now = Date.now();
	const { idle, active } = performance.eventLoopUtilization();
	// don't record boring entries
	if (has_updates || active * 10 > idle) {
		const id = getNextMonotonicTime();
		const value = {
			id,
			metric: 'main-thread-utilization',
			idle: idle - last_idle,
			active: active - last_active,
			taskQueueLatency: await task_queue_latency,
			time: now,
			...process.memoryUsage(),
		};
		analytics_table.primaryStore.put(id, value, { append: true }).then((success: boolean) => {
			// if for some reason we can't append, try again without append
			if (!success) {
				analytics_table.primaryStore.put(id, value);
			}
		});
	}
	last_idle = idle;
	last_active = active;

	// resource-usage metrics
	const resourceUsage = process.resourceUsage();
	const currentResourceUsage = diffResourceUsage(lastResourceUsage, resourceUsage);
	currentResourceUsage.time = now;
	currentResourceUsage.period = lastResourceUsage.time ? now - lastResourceUsage.time : to_period;
	currentResourceUsage.cpuUtilization = calculateCPUUtilization(lastResourceUsage, currentResourceUsage.period);
	storeMetric(analytics_table, 'resource-usage', currentResourceUsage);
	lastResourceUsage = currentResourceUsage;

	// database-size & table-size metrics
	const databases = getDatabases();
	storeDBSizeMetrics(analytics_table, databases);
	storeDBSizeMetrics(analytics_table, { system: databases.system });
}
let last_idle = 0;
let last_active = 0;
let lastResourceUsage: ResourceUsage = {};

const rest = () => new Promise(setImmediate);

async function cleanup(AnalyticsTable, expiration) {
	const end = Date.now() - expiration;
	for (const key of AnalyticsTable.primaryStore.getKeys({ start: false, end })) {
		AnalyticsTable.primaryStore.remove(key);
	}
}

const RAW_EXPIRATION = 3600000;
const AGGREGATE_EXPIRATION = 31536000000; // one year
let RawAnalyticsTable;
function getRawAnalyticsTable() {
	return (
		RawAnalyticsTable ||
		(RawAnalyticsTable = table({
			table: 'hdb_raw_analytics',
			database: 'system',
			audit: false,
			trackDeletes: false,
			attributes: [
				{
					name: 'id',
					isPrimaryKey: true,
				},
				{
					name: 'action',
				},
				{
					name: 'metrics',
				},
			],
		}))
	);
}
let AnalyticsTable;
function getAnalyticsTable() {
	return (
		AnalyticsTable ||
		(AnalyticsTable = table({
			table: 'hdb_analytics',
			database: 'system',
			audit: false,
			trackDeletes: false,
			attributes: [
				{
					name: 'id',
					isPrimaryKey: true,
				},
				{
					name: 'metric',
				},
				{
					name: 'path',
				},
				{
					name: 'method',
				},
				{
					name: 'type',
				},
			],
		}))
	);
}

setChildListenerByType(ANALYTICS_REPORT_TYPE, recordAnalytics);
let scheduled_tasks_running;
function startScheduledTasks() {
	scheduled_tasks_running = true;
	const AGGREGATE_PERIOD = env_get(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) * 1000;
	if (AGGREGATE_PERIOD) {
		setInterval(
			async () => {
				await aggregation(ANALYTICS_DELAY, AGGREGATE_PERIOD);
				await cleanup(getRawAnalyticsTable(), RAW_EXPIRATION);
				await cleanup(getAnalyticsTable(), AGGREGATE_EXPIRATION);
			},
			Math.min(AGGREGATE_PERIOD / 2, 0x7fffffff)
		).unref();
	}
}

let total_bytes_processed = 0;
const last_utilizations = new Map();
const LOG_ANALYTICS = false; // TODO: Make this a config option if we really want this
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
	getRawAnalyticsTable().primaryStore.put(report.id, report);
	if (!scheduled_tasks_running) startScheduledTasks();
	if (LOG_ANALYTICS) last_append = logAnalytics(report);
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

/**
 * This section contains a possible/experimental approach to bucketing values as they come instead of pushing all into an array and sorting.
 *
const BUCKET_COUNT = 100;
function addToBucket(action, value) {
	if (!action.buckets) {
		action.buckets = newBuckets();
	}
	const { counts, values, totalCount } = action.buckets;
	let jump = BUCKET_COUNT >> 1; // amount to jump with each iteration
	let position = jump; // start at halfway point
	while ((jump = jump >> 1) > 0) {
		const bucket_value = values[position];
		if (bucket_value === 0) {
			// unused slot, immediately put our value in
			counts[position] = 1;
			values[position] = value;
		}
		if (value > bucket_value) {
			position += jump;
		} else {
			position -= jump;
		}
	}
	const count = counts[position] + 1;
	if (position === BUCKET_COUNT) {
		// if we go beyond the last item, increase the bucket (max) value
		position--;
		values[position] = value;
	}
	if (count > threshold) {
		rebalance(action.buckets, false);
	} else {
		counts[position] = count;
	}
}

function newBuckets() {
	const ab = new ArrayBuffer(8 * BUCKET_COUNT);
	return {
		values: new Float32Array(ab, 0, BUCKET_COUNT),
		counts: new Uint32Array(ab, BUCKET_COUNT * 4, BUCKET_COUNT),
		totalCount: 0,
	};
}

let balancing_buckets;

 /**
 * Rebalance the buckets, we can reset the counts at the same time, if this occurred after a delivery
 * @param param
 * @param reset_counts
 *
function rebalance({ counts, values, totalCount }, reset_counts: boolean) {
	const count_per_bucket = totalCount / BUCKET_COUNT;
	let target_position = 0;
	let target_count = 0;
	let last_target_value = 0;
	const { values: target_values, counts: target_counts } = balancing_buckets || (balancing_buckets = newBuckets());
	for (let i = 0; i < BUCKET_COUNT; i++) {
		// iterate through the existing buckets, filling up the target buckets in a balanced way
		let count = counts[i];
		while ((count_per_bucket - target_count) < count) {
			const value = values[i];
			last_target_value = ((count_per_bucket - target_count) / count) * (value - last_target_value) + last_target_value;
			target_values[target_position] = last_target_value;
			target_counts[target_position] = count_per_bucket;
			count -= count_per_bucket;
			target_position++;
			target_count = 0;
		}
		target_count += count;
	}
	// now copy the balanced buckets back into the original buckets
	values.set(target_values);
	if (reset_counts) counts.fill(0);
	else counts.set(target_counts);
}
*/
