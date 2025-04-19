import { parentPort, threadId } from 'worker_threads';
import { setChildListenerByType } from '../../server/threads/manageThreads.js';
import { getDatabases, table } from '../databases.ts';
import type { Databases, Table, Tables } from '../databases.ts';
import { getLogFilePath } from '../../utility/logging/harper_logger.js';
import { loggerWithTag } from '../../utility/logging/logger.js';
import { dirname, join } from 'path';
import { open } from 'fs/promises';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility.js';
import { get as envGet, initSync } from '../../utility/environment/environmentManager.js';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { server } from '../../server/Server.ts';
import * as fs from 'node:fs';
import { getAnalyticsHostnameTable, nodeIds, stableNodeId } from './hostnames.ts';

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

let activeActions = new Map<string, Action>();
let analyticsEnabled = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1;

export function setAnalyticsEnabled(enabled: boolean) {
	analyticsEnabled = enabled;
}

function recordExistingAction(value: Value, action: Action) {
	if (typeof value === 'number') {
		let values: Float32Array = action.values;
		const index = values.index++;
		if (index >= values.length) {
			const oldValues = values;
			action.values = values = new Float32Array(index * 2);
			values.set(oldValues);
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
	activeActions.set(key, action);
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
	if (!analyticsEnabled) return;
	// TODO: May want to consider nested paths, as they may yield faster hashing of (fixed) strings that hashing concatenated strings
	let key = metric + (path ? '-' + path : '');
	if (method !== undefined) key += '-' + method;
	if (type !== undefined) key += '-' + type;
	const action = activeActions.get(key);
	if (action) {
		recordExistingAction(value, action);
	} else {
		recordNewAction(key, value, metric, path, method, type);
	}
	if (!analyticsStart) sendAnalytics();
}

server.recordAnalytics = recordAction;

export function recordActionBinary(value, metric, path?, method?, type?) {
	recordAction(Boolean(value), metric, path, method, type);
}

let analyticsStart = 0;
const ANALYTICS_DELAY = 1000;
const ANALYTICS_REPORT_TYPE = 'analytics-report';
const analyticsListeners = [];

export function addAnalyticsListener(callback) {
	analyticsListeners.push(callback);
}

const IDEAL_PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1];

/**
 * Periodically send analytics data back to the main thread for storage
 */
function sendAnalytics() {
	analyticsStart = performance.now();
	setTimeout(async () => {
		const period = performance.now() - analyticsStart;
		analyticsStart = 0;
		const metrics = [];
		const report = {
			time: Date.now(),
			period,
			threadId,
			metrics,
		};
		for (const [name, action] of activeActions) {
			if (action.values) {
				const values = action.values.subarray(0, action.values.index);
				values.sort();
				const count = values.length;
				// compute the stats
				let lastUpperBound = 0;
				const distribution = [];
				let lastValue;
				for (const percentile of IDEAL_PERCENTILES) {
					const upperBound = Math.floor(count * percentile);
					const value = values[upperBound - 1];
					if (upperBound > lastUpperBound) {
						const count = upperBound - lastUpperBound;
						if (value === lastValue) {
							const entry = distribution[distribution.length - 1];
							if (typeof entry === 'number') distribution[distribution.length - 1] = { value: entry, count: 1 + count };
							else entry.count += count;
						} else {
							distribution.push(count > 1 ? { value, count } : value);
							lastValue = value;
						}
						lastUpperBound = upperBound;
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
		const memoryUsage = process.memoryUsage();
		metrics.push({
			metric: 'memory',
			threadId,
			byThread: true,
			...memoryUsage,
		});
		for (const listener of analyticsListeners) {
			listener(metrics);
		}
		activeActions = new Map();
		if (parentPort)
			parentPort.postMessage({
				type: ANALYTICS_REPORT_TYPE,
				report,
			});
		else recordAnalytics({ report });
	}, ANALYTICS_DELAY).unref();
}

export async function recordHostname() {
	const hostname = server.hostname;
	log.trace?.('recordHostname server.hostname:', hostname);
	const nodeId = stableNodeId(hostname);
	log.trace?.('recordHostname nodeId:', nodeId);
	const hostnamesTable = getAnalyticsHostnameTable();
	const record = await hostnamesTable.get(nodeId);
	if (!record) {
		const hostnameRecord = {
			id: nodeId,
			hostname,
		};
		log.trace?.(`storing hostname: ${JSON.stringify(hostnameRecord)}`);
		hostnamesTable.put(hostnameRecord.id, hostnameRecord);
	}
}

export interface Metric {
	[key: string]: any;
}

function storeMetric(table: Table, metric: Metric) {
	const hostname = server.hostname;
	let nodeId = nodeIds.get(hostname);
	if (nodeId) {
		log.trace?.('storeMetric cached nodeId:', nodeId)
	} else {
		nodeId = stableNodeId(hostname);
		log.trace?.('storeMetric new nodeId:', nodeId);
		nodeIds.set(hostname, nodeId);
	}
	const metricValue = {
		id: [getNextMonotonicTime(), nodeId],
		...metric,
	};
	log.trace?.(`storing metric ${JSON.stringify(metricValue)}`);
	table.put(metricValue.id, metricValue);
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
			metric: 'table-size',
			database: dbName,
			table: tableName,
			size: tableSize,
		};
		log.trace?.(`table ${fullTableName} size metric: ${JSON.stringify(metric)}`);
		storeMetric(analyticsTable, metric);
		dbUsedSize += tableSize;
	}
	return dbUsedSize;
}

function storeDBSizeMetrics(analyticsTable: Table, databases: Databases) {
	for (const [db, tables] of Object.entries(databases)) {
		try {
			const [firstTable] = Object.values(tables);
			const dbAuditSize = firstTable?.getAuditSize();
			if (!dbAuditSize) {
				return;
			}
			const dbTotalSize = fs.statSync(firstTable.primaryStore.env.path).size;
			const dbUsedSize = storeTableSizeMetrics(analyticsTable, db, tables);
			const dbFree = dbTotalSize - dbUsedSize;
			const metric = {
				metric: 'database-size',
				database: db,
				size: dbTotalSize,
				used: dbUsedSize,
				free: dbFree,
				audit: dbAuditSize,
			};
			storeMetric(analyticsTable, metric);
			log.trace?.(`database ${db} size metric: ${JSON.stringify(metric)}`);
		} catch (error) {
			// a table or db was deleted, could get an error here
			log.warn?.(`Error getting DB size metrics`, error);
		}
	}
}

function storeVolumeMetrics(analyticsTable: Table, databases: Databases) {
	for (const [db, tables] of Object.entries(databases)) {
		try {
			const [firstTable] = Object.values(tables);
			const storageStats = firstTable?.getStorageStats();
			if (!storageStats) {
				return;
			}
			const metric = {
				metric: 'storage-volume',
				database: db,
				...storageStats,
			};
			storeMetric(analyticsTable, metric);
			log.trace?.(`db ${db} storage volume metrics: ${JSON.stringify(metric)}`);
		} catch (error) {
			// a table or db was deleted, could get an error here
			log.warn?.(`Error getting DB volume metrics`, error);
		}
	}
}

async function aggregation(fromPeriod, toPeriod = 60000) {
	const rawAnalyticsTable = getRawAnalyticsTable();
	const analyticsTable = getAnalyticsTable();
	const taskQueueLatency = new Promise((resolve) => {
		let start = performance.now();
		setImmediate(() => {
			const now = performance.now();
			if (now - start > 5000)
				log.warn?.('Unusually high event queue latency on the main thread of ' + Math.round(now - start) + 'ms');
			start = performance.now(); // We use this start time to measure the time it actually takes to on the task queue, minus the time on the event queu
		});
		analyticsTable.primaryStore.prefetch([1], () => {
			const now = performance.now();
			if (now - start > 5000)
				log.warn?.('Unusually high task queue latency on the main thread of ' + Math.round(now - start) + 'ms');
			resolve(now - start);
		});
	});
	let lastForPeriod;
	// find the last entry for this period
	for (const entry of analyticsTable.primaryStore.getRange({
		start: Infinity,
		end: false,
		reverse: true,
	})) {
		if (!entry.value?.time) continue;
		lastForPeriod = entry.value.time;
		break;
	}
	// was the last aggregation too recent to calculate a whole period?
	if (Date.now() - toPeriod < lastForPeriod) return;
	let firstForPeriod;
	const aggregateActions = new Map();
	const distributions = new Map();
	const threadsToAverage = [];
	let lastTime: number;
	for (const { key, value } of rawAnalyticsTable.primaryStore.getRange({
		start: lastForPeriod || false,
		exclusiveStart: true,
		end: Infinity,
	})) {
		if (!value) continue;
		if (firstForPeriod) {
			if (key > firstForPeriod + toPeriod) break; // outside the period of interest
		} else firstForPeriod = key;
		lastTime = key;
		const { metrics, threadId } = value;
		for (const entry of metrics || []) {
			let { path, method, type, metric, count, total, distribution, threads, ...measures } = entry;
			if (!count) count = 1;
			let key = metric + (path ? '-' + path : '');
			if (method !== undefined) key += '-' + method;
			if (type !== undefined) key += '-' + type;
			let action = aggregateActions.get(key);
			if (action) {
				if (action.threads) {
					const actionForThread = action.threads[threadId];
					if (actionForThread) action = actionForThread;
					else {
						action.threads[threadId] = { ...measures };
						continue;
					}
				}
				if (!action.count) action.count = 1;
				const previousCount = action.count;
				for (const measureName in measures) {
					const value = measures[measureName];
					if (typeof value === 'number') {
						action[measureName] = (action[measureName] * previousCount + value * count) / (previousCount + count);
					}
				}
				action.count += count;
				if (total >= 0) {
					action.total += total;
					action.ratio = action.total / action.count;
				}
			} else {
				action = { period: toPeriod, ...entry };
				delete action.distribution;
				aggregateActions.set(key, action);
				if (action.byThread) {
					action.threads = [];
					action.threads[threadId] = { ...measures };
					threadsToAverage.push(action);
				}
			}
			if (distribution) {
				distribution = distribution.map((entry) => (typeof entry === 'number' ? { value: entry, count: 1 } : entry));
				const existingDistribution = distributions.get(key);
				if (!existingDistribution) distributions.set(key, distribution);
				else {
					existingDistribution.push(...distribution);
				}
			}
		}
		await rest();
	}
	for (const entry of threadsToAverage) {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars,prefer-const
		let { path, method, type, metric, count, total, distribution, threads, ...measures } = entry;
		threads = threads.filter((thread) => thread);
		for (const measureName in measures) {
			if (typeof entry[measureName] !== 'number') continue;
			let total = 0;
			for (const thread of threads) {
				const value = thread[measureName];
				if (typeof value === 'number') {
					total += value;
				}
			}
			entry[measureName] = total;
		}
		entry.count = threads.length;
		delete entry.threads;
		delete entry.byThread;
	}
	for (const [key, distribution] of distributions) {
		// now iterate through the distributions finding the close bin to each percentile and interpolating the position in that bin
		const action = aggregateActions.get(key);
		distribution.sort((a, b) => (a.value > b.value ? 1 : -1));
		const count = action.count - 1;
		const percentiles = [];
		let countPosition = 0;
		let index = 0;
		let bin;
		for (const percentile of IDEAL_PERCENTILES) {
			const nextTargetCount = count * percentile;
			while (countPosition < nextTargetCount) {
				bin = distribution[index++];
				countPosition += bin.count;
				// we decrement these counts so we are skipping the minimum value in our interpolation
				if (index === 1) countPosition--;
			}
			const previousBin = distribution[index > 1 ? index - 2 : 0];
			if (!bin) bin = distribution[0];
			percentiles.push(
				bin.value - ((bin.value - previousBin.value) * (countPosition - nextTargetCount)) / bin.count
			);
		}
		const [p1, p10, p25, median, p75, p90, p95, p99, p999] = percentiles;
		Object.assign(action, { p1, p10, p25, median, p75, p90, p95, p99, p999 });
	}
	let hasUpdates;
	for (const [, value] of aggregateActions) {
		value.time = lastTime;
		storeMetric(analyticsTable, value);
		hasUpdates = true;
	}
	const now = Date.now();
	const { idle, active } = performance.eventLoopUtilization();
	// don't record boring entries
	if (hasUpdates || active * 10 > idle) {
		const value = {
			metric: 'main-thread-utilization',
			idle: idle - lastIdle,
			active: active - lastActive,
			taskQueueLatency: await taskQueueLatency,
			time: now,
			...process.memoryUsage(),
		};
		storeMetric(analyticsTable, value);
	}
	lastIdle = idle;
	lastActive = active;

	// resource-usage metrics
	const resourceUsage = process.resourceUsage();
	const currentResourceUsage = diffResourceUsage(lastResourceUsage, resourceUsage);
	currentResourceUsage.time = now;
	currentResourceUsage.period = lastResourceUsage.time ? now - lastResourceUsage.time : toPeriod;
	currentResourceUsage.cpuUtilization = calculateCPUUtilization(lastResourceUsage, currentResourceUsage.period);
	const cruMetric = {
		metric: 'resource-usage',
		...currentResourceUsage,
	};
	storeMetric(analyticsTable, cruMetric);
	lastResourceUsage = currentResourceUsage;

	// database-size & table-size metrics
	const databases = getDatabases();
	storeDBSizeMetrics(analyticsTable, databases);
	storeDBSizeMetrics(analyticsTable, { system: databases.system });

	// database storage volume metrics
	storeVolumeMetrics(analyticsTable, databases);
	storeVolumeMetrics(analyticsTable, { system: databases.system });
}
let lastIdle = 0;
let lastActive = 0;
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

let RawAnalyticsTable: Table;
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

let AnalyticsTable: Table;
function getAnalyticsTable() {
	return (
		AnalyticsTable ||
		(AnalyticsTable = table({
			table: 'hdb_analytics',
			database: 'system',
			audit: true,
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
let scheduledTasksRunning;
function startScheduledTasks() {
	scheduledTasksRunning = true;
	const AGGREGATE_PERIOD = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) * 1000;
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

let totalBytesProcessed = 0;
const lastUtilizations = new Map();
const LOG_ANALYTICS = false; // TODO: Make this a config option if we really want this
function recordAnalytics(message, worker?) {
	const report = message.report;
	report.threadId = worker?.threadId || threadId;
	// Add system information stats as well
	for (const metric of report.metrics) {
		if (metric.metric === 'bytes-sent') {
			totalBytesProcessed += metric.mean * metric.count;
		}
	}
	report.totalBytesProcessed = totalBytesProcessed;
	if (worker) {
		report.metrics.push({
			metric: 'utilization',
			...worker.performance.eventLoopUtilization(lastUtilizations.get(worker)),
		});
		lastUtilizations.set(worker, worker.performance.eventLoopUtilization());
	}
	report.id = getNextMonotonicTime();
	getRawAnalyticsTable().primaryStore.put(report.id, report);
	if (!scheduledTasksRunning) startScheduledTasks();
	if (LOG_ANALYTICS) lastAppend = logAnalytics(report);
}
let lastAppend;
let analyticsLog;
const MAX_ANALYTICS_SIZE = 1000000;
async function logAnalytics(report) {
	await lastAppend;
	if (!analyticsLog) {
		const logDir = dirname(getLogFilePath());
		try {
			analyticsLog = await open(join(logDir, 'analytics.log'), 'r+');
		} catch (error) {
			analyticsLog = await open(join(logDir, 'analytics.log'), 'w+');
		}
	}
	let position = (await analyticsLog.stat()).size;
	if (position > MAX_ANALYTICS_SIZE) {
		let contents = Buffer.alloc(position);
		await analyticsLog.read(contents, { position: 0 });
		contents = contents.subarray(contents.indexOf(10, contents.length / 2) + 1); // find a carriage return to break on after the halfway point
		await analyticsLog.write(contents, { position: 0 });
		await analyticsLog.truncate(contents.length);
		position = contents.length;
	}
	await analyticsLog.write(JSON.stringify(report) + '\n', position);
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
		const bucketValue = values[position];
		if (bucketValue === 0) {
			// unused slot, immediately put our value in
			counts[position] = 1;
			values[position] = value;
		}
		if (value > bucketValue) {
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

let balancingBuckets;

 /**
 * Rebalance the buckets, we can reset the counts at the same time, if this occurred after a delivery
 * @param param
 * @param resetCounts
 *
function rebalance({ counts, values, totalCount }, resetCounts: boolean) {
	const countPerBucket = totalCount / BUCKET_COUNT;
	let targetPosition = 0;
	let targetCount = 0;
	let lastTargetValue = 0;
	const { values: targetValues, counts: targetCounts } = balancingBuckets || (balancingBuckets = newBuckets());
	for (let i = 0; i < BUCKET_COUNT; i++) {
		// iterate through the existing buckets, filling up the target buckets in a balanced way
		let count = counts[i];
		while ((countPerBucket - targetCount) < count) {
			const value = values[i];
			lastTargetValue = ((countPerBucket - targetCount) / count) * (value - lastTargetValue) + lastTargetValue;
			targetValues[targetPosition] = lastTargetValue;
			targetCounts[targetPosition] = countPerBucket;
			count -= countPerBucket;
			targetPosition++;
			targetCount = 0;
		}
		targetCount += count;
	}
	// now copy the balanced buckets back into the original buckets
	values.set(targetValues);
	if (resetCounts) counts.fill(0);
	else counts.set(targetCounts);
}
*/
