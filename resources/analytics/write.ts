import { parentPort, threadId } from 'node:worker_threads';
import { onStartup } from '../../utility/lifecycle.ts';
import { onMessageByType } from '../../server/threads/manageThreads.ts';
import { getDatabases, table, isReadOnlyMode } from '../databases.ts';
import type { Databases, Table, Tables } from '../databases.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { stat, opendir } from 'node:fs/promises';
const { getLogFilePath, forComponent } = harperLogger;
import { dirname, join } from 'node:path';
import { open } from 'node:fs/promises';
import { getNextMonotonicTime } from '../../utility/lmdb/commonUtility.ts';
import { cleanupExpiredAnalytics } from './cleanup.ts';
import { get as envGet, getHdbBasePath } from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS, MAX_SET_TIMEOUT_MS } from '../../utility/hdbTerms.ts';
import { server } from '../../server/Server.ts';
import * as fs from 'node:fs';
import { getAnalyticsHostnameTable, nodeIds, stableNodeId } from './hostnames.ts';
import { METRIC } from './metadata.ts';
import { acceptsFullTextTelemetryRow, setFullTextAnalyticsEnabled } from './fullTextTelemetryRuntime.ts';
import {
	readEventLoopDelay,
	resetEventLoopDelay,
	startEventLoopDelayMonitor,
	stopEventLoopDelayMonitor,
} from '../../server/eventLoopDelay.ts';
import { getTransactionQueueDepths, setCommitLatencyRecorder } from '../DatabaseTransaction.ts';
import { contextStorage } from '../transaction.ts';
import { RocksDatabase, type TransactionLogStats } from '@harperfast/rocksdb-js';

const log = forComponent('analytics').conditional;
const isBun = typeof globalThis.Bun !== 'undefined';

type ActionCallback = (action: Action) => void;
export type Value = number | boolean | ActionCallback;
interface Action {
	total?: number;
	values?: Float32Array;
	runs?: Uint16Array;
	runCount?: number;
	samples?: number;
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

/**
 * One level of actionIndex. Each level takes the shape its own cardinality calls for: an array scanned with
 * Map's key equality while it holds a few keys (a verb, a type, a table: most levels), which costs less than
 * Map.get, and a Map once it outgrows that (paths).
 */
class IndexLevel<T> {
	keys: unknown[] | null = [];
	entries: T[] | null = [];
	map: Map<unknown, T> | null = null;
	get(key: unknown): T | undefined {
		if (this.map !== null) return this.map.get(key);
		const keys = this.keys!;
		for (let i = 0; i < keys.length; i++) {
			const candidate = keys[i];
			if (candidate === key || (candidate !== candidate && key !== key)) return this.entries![i];
		}
		return undefined;
	}
	set(key: unknown, entry: T) {
		if (this.map !== null) return void this.map.set(key, entry);
		const keys = this.keys!;
		keys.push(key);
		this.entries!.push(entry);
		if (keys.length > INDEX_ARRAY_KEYS) {
			const map = new Map<unknown, T>();
			for (let i = 0; i < keys.length; i++) map.set(keys[i], this.entries![i]);
			this.map = map;
			this.keys = this.entries = null;
		}
	}
}
const INDEX_ARRAY_KEYS = 8;

class MetricIndex {
	byMethod = new IndexLevel<IndexLevel<IndexLevel<Action>>>();
	lastAction: Action | undefined = undefined;
	lastPath: unknown;
	lastMethod: unknown;
	lastType: unknown;
}
// activeActions by recordAction's arguments as given. A tuple enters only once activeActions already holds
// its action, so an action recorded once in a window is never indexed.
let actionIndex = new Map<string, MetricIndex>();
let analyticsEnabled = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1;
let analyticsReadOnlyChecked = false;
let sendAnalyticsTimeout: NodeJS.Timeout;
let analyticsGeneration = 0;
let analyticsWindow = 0;
let analyticsExiting = false;
let runningAnalyticsFlush: Promise<void> | undefined;
let exitAnalyticsFlush: Promise<void> | undefined;

onStartup(() => {
	analyticsEnabled = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) > -1;
	analyticsReadOnlyChecked = false;
	setFullTextAnalyticsEnabled(checkAnalyticsEnabled(false));
});

// Check read-only mode lazily to avoid circular dependency at module load time. The event loop
// sampler starts here rather than at load, so a read-only worker never runs it.
export function checkAnalyticsEnabled(startSampler = true): boolean {
	if (!startSampler) return analyticsEnabled && !isReadOnlyMode();
	if (!analyticsReadOnlyChecked) {
		analyticsReadOnlyChecked = true;
		if (isReadOnlyMode()) analyticsEnabled = false;
		else if (analyticsEnabled) startEventLoopDelayMonitor();
	}
	return analyticsEnabled;
}

/** Resets this thread's analytics window; other threads keep their own. */
export function setAnalyticsEnabled(enabled: boolean) {
	analyticsEnabled = enabled;
	setFullTextAnalyticsEnabled(enabled);
	if (enabled) startEventLoopDelayMonitor();
	else stopEventLoopDelayMonitor();
	clearTimeout(sendAnalyticsTimeout); // reset this
	sendAnalyticsTimeout = null;
	// The cancelled window must not stretch the next one's period, skip its histogram reset, or leak its samples.
	analyticsStart = 0;
	lastFlushAt = 0;
	// a recorder keeps its action until it is next called, so the dropped window's samples are released here
	for (const action of activeActions.values()) action.values = action.runs = undefined;
	activeActions = new Map();
	actionIndex = new Map();
	analyticsWindow++;
	getTransactionQueueDepths(); // restarts the queue high-water marks with the window
	analyticsGeneration++;
}

function recordExistingAction(value: Value, action: Action) {
	if (typeof value === 'number') {
		const last = action.runCount - 1;
		const lastValue = action.values[last];
		// Runs hold float32 values, so a value float32 rounds (0.1) still matches its run. 0 and -0 compare equal but
		// sort apart, so they never share a run.
		const stored = Math.fround(value);
		if (stored === lastValue && action.runs[last] < MAX_RUN && (stored !== 0 || Object.is(stored, lastValue)))
			action.runs[last]++;
		else appendRun(action, value);
		action.samples++;
		action.total += value;
	} else if (typeof value === 'boolean') {
		if (value) action.total++;
		action.count++;
	} else if (typeof value === 'function') {
		// nothing to do except wait for the callback
		action.count++;
	} else throw new TypeError('Invalid metric value type ' + typeof value);
}

const MAX_RUN = 0xffff;
type RunCounts = Uint16Array | Uint32Array;

function appendRun(action: Action, value: number) {
	const index = action.runCount;
	if (index === action.values.length) {
		const values = new Float32Array(index * 2);
		const runs = new Uint16Array(index * 2);
		values.set(action.values);
		runs.set(action.runs);
		action.values = values;
		action.runs = runs;
	}
	action.values[index] = value;
	action.runs[index] = 1;
	action.runCount = index + 1;
}

function recordNewAction(key: string, value: Value, metric?: string, path?: string, method?: string, type?: string) {
	const action: Action = {};
	if (typeof value === 'number') {
		action.values = new Float32Array(4);
		action.runs = new Uint16Array(4);
		action.values[0] = value;
		action.runs[0] = 1;
		action.runCount = 1;
		action.samples = 1;
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
	if (!checkAnalyticsEnabled() || analyticsExiting) return;
	const indexed = actionIndex.get(metric);
	if (indexed !== undefined) {
		let action =
			path === indexed.lastPath && method === indexed.lastMethod && type === indexed.lastType
				? indexed.lastAction
				: undefined;
		if (action === undefined) {
			action = indexed.byMethod.get(method)?.get(type)?.get(path);
			if (action !== undefined) {
				indexed.lastAction = action;
				indexed.lastPath = path;
				indexed.lastMethod = method;
				indexed.lastType = type;
			}
		}
		if (action !== undefined) {
			recordExistingAction(value, action);
			armFlush();
			return;
		}
	}
	const existing = recordKeyedAction(actionKey(metric, path, method, type), value, metric, path, method, type);
	if (existing !== undefined && isPrimitive(path) && isPrimitive(method) && isPrimitive(type))
		indexedActionsByPath(metric, method, type).set(path, existing);
}

// Keyed by identity, a fresh object per call (a request body's operation) would add an entry per call
function isPrimitive(value: unknown): boolean {
	return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

export function isActionIndexedForTests(metric: string, path?: string, method?: string, type?: string): boolean {
	return actionIndex.get(metric)?.byMethod.get(method)?.get(type)?.get(path) !== undefined;
}

function indexedActionsByPath(metric: string, method?: string, type?: string): IndexLevel<Action> {
	let indexed = actionIndex.get(metric);
	if (indexed === undefined) actionIndex.set(metric, (indexed = new MetricIndex()));
	let byType = indexed.byMethod.get(method);
	if (byType === undefined) indexed.byMethod.set(method, (byType = new IndexLevel()));
	let byPath = byType.get(type);
	if (byPath === undefined) byType.set(type, (byPath = new IndexLevel()));
	return byPath;
}

/**
 * recordAction for one fixed set of arguments, for a hot path: it looks its action up once per analytics window.
 * Within a window the flush timer is already armed, since only a rotation or an exit disarms it.
 */
export function actionRecorder(metric: string, path?: string, method?: string, type?: string): (value: Value) => void {
	const key = actionKey(metric, path, method, type);
	let action: Action | undefined;
	let window = -1;
	return (value) => {
		if (!checkAnalyticsEnabled() || analyticsExiting) return;
		if (window === analyticsWindow) return recordExistingAction(value, action);
		recordKeyedAction(key, value, metric, path, method, type);
		action = activeActions.get(key);
		window = analyticsWindow;
	};
}

function actionKey(metric: string, path?: string, method?: string, type?: string): string {
	let key = metric + (path ? '-' + path : '');
	if (method !== undefined) key += '-' + method;
	if (type !== undefined) key += '-' + type;
	return key;
}

/** The action the window already held for the key; undefined when this call started it */
function recordKeyedAction(
	key: string,
	value: Value,
	metric: string,
	path?: string,
	method?: string,
	type?: string
): Action | undefined {
	const action = activeActions.get(key);
	if (action) {
		recordExistingAction(value, action);
	} else {
		recordNewAction(key, value, metric, path, method, type);
	}
	armFlush();
	return action;
}

function armFlush() {
	if (!sendAnalyticsTimeout) contextStorage.exit(sendAnalytics);
}

// Let the storage layer emit write-commit latency without statically depending on this module.
setCommitLatencyRecorder(actionRecorder(METRIC.TRANSACTION_COMMIT_TIME));

export function recordActionBinary(value, metric, path?, method?, type?) {
	recordAction(Boolean(value), metric, path, method, type);
}

let analyticsStart = 0;
let lastFlushAt = 0;
export const analyticsDelay = 1000;
const ANALYTICS_REPORT_TYPE = 'analytics-report';
const analyticsListeners = [];
const analyticsAggregateListeners = [];

export function addAnalyticsListener(callback) {
	analyticsListeners.push(callback);
	return () => {
		const index = analyticsListeners.indexOf(callback);
		if (index >= 0) analyticsListeners.splice(index, 1);
	};
}

export function requestAnalyticsFlush(): void {
	if (!analyticsExiting && checkAnalyticsEnabled() && !sendAnalyticsTimeout) contextStorage.exit(sendAnalytics);
}

/** Deliver the last window after resource owners close, without starting new periodic work. */
export function flushAnalyticsForExit(): Promise<void> {
	if (exitAnalyticsFlush) return exitAnalyticsFlush;
	analyticsExiting = true;
	clearTimeout(sendAnalyticsTimeout);
	sendAnalyticsTimeout = null;
	return (exitAnalyticsFlush = contextStorage.exit(async () => {
		await runningAnalyticsFlush?.catch(() => {});
		try {
			if (checkAnalyticsEnabled(false)) await flushAnalytics(true);
			else for (const listener of [...analyticsListeners]) listener([], true);
		} finally {
			// a callback or listener that throws must not cost the reports already admitted
			if (!parentPort) {
				// a report arriving while these settle starts more of either
				while (summarizing || reportWrites.size > 0) {
					await summarizing;
					await Promise.all(reportWrites);
				}
				await RawAnalyticsTable?.primaryStore.committed;
			}
		}
	}));
}

const IDEAL_PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1];
interface SampleRuns {
	values: Float32Array;
	runs: RunCounts;
	length: number;
}

type Distribution = Array<number | { value: number; count: number }>;

/**
 * The percentile distribution of a numeric action's samples, given as runs: what sorting every sample would give,
 * from sorting only the runs and counting through them to each percentile's position. Sorts the runs in place.
 */
export function distributionOfRuns(values: Float32Array, runs: RunCounts, length: number, count: number): Distribution {
	const steps = distributionSteps(values, runs, length, count);
	let step = steps.next();
	while (!step.done) step = steps.next();
	return step.value;
}

function* distributionSteps(
	values: Float32Array,
	runs: RunCounts,
	length: number,
	count: number
): Generator<void, Distribution> {
	yield* sortRunsSteps(values, runs, length);
	return percentileDistribution(values, runs, count);
}

function percentileDistribution(values: Float32Array, runs: RunCounts, count: number): Distribution {
	const distribution: Distribution = [];
	let lastUpperBound = 0;
	let lastValue: number;
	let run = 0;
	let through = runs[0];
	for (const percentile of IDEAL_PERCENTILES) {
		const upperBound = Math.floor(count * percentile);
		if (upperBound > lastUpperBound) {
			while (through < upperBound) through += runs[++run];
			const value = values[run];
			const bucket = upperBound - lastUpperBound;
			if (value === lastValue) {
				const entry = distribution[distribution.length - 1];
				if (typeof entry === 'number') distribution[distribution.length - 1] = { value: entry, count: 1 + bucket };
				else entry.count += bucket;
			} else {
				distribution.push(bucket > 1 ? { value, count: bucket } : value);
				lastValue = value;
			}
			lastUpperBound = upperBound;
		}
	}
	return distribution;
}

const RADIX_BITS = 11;
const RADIX_MASK = (1 << RADIX_BITS) - 1;
const INSERTION_SORT_MAX = 32;
const STEP_RUNS = 1 << 16;
let radixCounts: Uint32Array | undefined;

interface RadixState {
	keys: Uint32Array;
	spareKeys: Uint32Array;
	runs: RunCounts;
	spareRuns: RunCounts;
}

/**
 * Sorts the first `length` runs by value, in place, into the order Float32Array#sort gives: numeric, -0 before 0,
 * NaN last. Each value's float32 bits are mapped so that unsigned order is that order, then radix sorted in at most
 * three linear passes (a pass whose digit every key shares is skipped), carrying the run counts along. The typed
 * array's own sort compares, which costs several times as much on values that do not repeat.
 */
function* sortRunsSteps(values: Float32Array, runs: RunCounts, length: number): Generator<void, void> {
	const bits = new Uint32Array(values.buffer, values.byteOffset, length);
	const keys = sortKeys(bits, length);
	const stepped = length >= STEP_RUNS;
	if (length <= INSERTION_SORT_MAX) {
		insertionSort(keys, runs, length);
		restoreBits(bits, keys, length);
		return;
	}
	if (stepped) yield;
	const state: RadixState = {
		keys,
		spareKeys: new Uint32Array(length),
		runs: runs.subarray(0, length),
		spareRuns: runs instanceof Uint16Array ? new Uint16Array(length) : new Uint32Array(length),
	};
	for (let shift = 0; shift < 32; shift += RADIX_BITS) {
		if (radixPass(state, shift, length) && stepped) yield;
	}
	if (state.runs.buffer !== runs.buffer) runs.set(state.runs);
	restoreBits(bits, state.keys, length);
}

function sortKeys(bits: Uint32Array, length: number): Uint32Array {
	const keys = new Uint32Array(length);
	for (let i = 0; i < length; i++) {
		const b = bits[i];
		keys[i] = (b & 0x7fffffff) > 0x7f800000 ? 0xffffffff : b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
	}
	return keys;
}

function restoreBits(bits: Uint32Array, keys: Uint32Array, length: number) {
	for (let i = 0; i < length; i++) {
		const key = keys[i];
		bits[i] = key & 0x80000000 ? key & 0x7fffffff : ~key >>> 0;
	}
}

function insertionSort(keys: Uint32Array, runs: RunCounts, length: number) {
	for (let i = 1; i < length; i++) {
		const key = keys[i];
		const run = runs[i];
		let j = i - 1;
		for (; j >= 0 && keys[j] > key; j--) {
			keys[j + 1] = keys[j];
			runs[j + 1] = runs[j];
		}
		keys[j + 1] = key;
		runs[j + 1] = run;
	}
}

function radixPass(state: RadixState, shift: number, length: number): boolean {
	const counts = (radixCounts ??= new Uint32Array(1 << RADIX_BITS));
	const { keys, spareKeys, runs, spareRuns } = state;
	counts.fill(0);
	for (let i = 0; i < length; i++) counts[(keys[i] >>> shift) & RADIX_MASK]++;
	if (counts[(keys[0] >>> shift) & RADIX_MASK] === length) return false;
	let offset = 0;
	for (let digit = 0; digit <= RADIX_MASK; digit++) {
		const digitCount = counts[digit];
		counts[digit] = offset;
		offset += digitCount;
	}
	for (let i = 0; i < length; i++) {
		const key = keys[i];
		const position = counts[(key >>> shift) & RADIX_MASK]++;
		spareKeys[position] = key;
		spareRuns[position] = runs[i];
	}
	state.keys = spareKeys;
	state.spareKeys = keys;
	state.runs = spareRuns;
	state.spareRuns = runs;
	return true;
}

/**
 * Periodically send analytics data back to the main thread for storage. Callers arm it through
 * contextStorage.exit(): the first sample of a period comes from some request, but the flush and the
 * scheduled tasks it starts are process-wide work, which under that request's context would write as
 * its user and, once its client disconnected, have every write rejected by its aborted signal.
 */
function sendAnalytics() {
	if (!analyticsStart) {
		analyticsStart = performance.now();
		// After an idle gap or at boot, the report's delay covers its own window, not the gap. Right
		// after a flush, which already reset the histogram, another reset would only add a blind spot.
		if (!lastFlushAt || analyticsStart - lastFlushAt > analyticsDelay) resetEventLoopDelay();
	}
	sendAnalyticsTimeout = setTimeout(() => {
		// One more timer turn: a stall that ran past the deadline is recorded by the event loop
		// sampler's overdue firing, which libuv runs before a timer armed now, and the read below
		// would otherwise reset that sample away.
		sendAnalyticsTimeout = setTimeout(flushPeriodicAnalytics, 0).unref();
	}, analyticsDelay).unref();
}

function flushPeriodicAnalytics(): void {
	void flushAnalytics().catch((error) => log.error?.('Analytics flush failed', error));
}

function flushAnalytics(final = false): Promise<void> {
	const run = () => collectAnalytics(final);
	const result = runningAnalyticsFlush ? runningAnalyticsFlush.then(run, run) : run();
	runningAnalyticsFlush = result;
	const settled = () => {
		if (runningAnalyticsFlush === result) runningAnalyticsFlush = undefined;
	};
	void result.then(settled, settled);
	return result;
}

async function collectAnalytics(final: boolean) {
	sendAnalyticsTimeout = null;
	const generation = analyticsGeneration;
	// Rotate before the first yield below: a sample recorded mid-flush would otherwise be added to
	// an entry already reported, and dropped with it.
	const reportingActions = activeActions;
	activeActions = new Map();
	actionIndex = new Map();
	analyticsWindow++;
	const period = analyticsStart ? performance.now() - analyticsStart : 0;
	analyticsStart = 0;
	// Read before the first yield too, so the event loop's samples from the rest of the flush belong
	// to the next report.
	const eventLoopDelay = readEventLoopDelay();
	lastFlushAt = performance.now();
	const metrics = [];
	const report = {
		time: Date.now(),
		period,
		threadId,
		metrics,
	};
	const sampled = parentPort ? new Map<object, SampleRuns>() : undefined;
	try {
		for (const [_name, action] of reportingActions) {
			if (action.values) {
				const count = action.samples;
				if (sampled) {
					const entry = Object.assign(action.description, { mean: action.total / count, count });
					metrics.push(entry);
					sampled.set(entry, { values: action.values, runs: action.runs, length: action.runCount });
				} else {
					metrics.push(
						Object.assign(action.description, {
							mean: action.total / count,
							distribution: distributionOfRuns(action.values, action.runs, action.runCount, count),
							count,
						})
					);
				}
				action.values = action.runs = undefined;
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
			if (!parentPort || action.callback) {
				await rest();
				if (generation !== analyticsGeneration) {
					for (const dropped of reportingActions.values()) dropped.values = dropped.runs = undefined;
					return;
				}
			}
		}
	} catch (error) {
		// a callback threw: an idle recorder would otherwise keep the rest of the window's samples for good
		for (const action of reportingActions.values()) action.values = action.runs = undefined;
		throw error;
	}
	const memoryUsage = process.memoryUsage();
	metrics.push({
		metric: 'memory',
		threadId,
		byThread: true,
		...memoryUsage,
	});
	if (eventLoopDelay) {
		metrics.push({
			metric: METRIC.EVENT_LOOP_DELAY,
			threadId,
			perThread: true,
			...eventLoopDelay,
		});
	}
	// Transaction queue depth gauges. `depth` is the instantaneous depth at emit time; `maxDepth` is
	// the high-water mark over this sampling window (the queue can fill and drain within a single
	// period, so the instantaneous sample alone would miss short spikes). Reported per-thread and
	// summed across threads by the aggregator, mirroring the `memory` gauge above.
	const queueDepths = getTransactionQueueDepths();
	metrics.push({
		metric: METRIC.WRITE_TRANSACTION_QUEUE_DEPTH,
		threadId,
		byThread: true,
		depth: queueDepths.writeDepth,
		maxDepth: queueDepths.writeMaxDepth,
	});
	metrics.push({
		metric: METRIC.READ_TRANSACTION_QUEUE_DEPTH,
		threadId,
		byThread: true,
		depth: queueDepths.readDepth,
		maxDepth: queueDepths.readMaxDepth,
	});
	for (const listener of [...analyticsListeners]) {
		if (generation !== analyticsGeneration) return;
		listener(metrics, final);
	}
	if (generation !== analyticsGeneration) return;
	if (sampled) {
		// by position once the listeners are done with the array: one may have added or removed entries
		const runs = [];
		const transfer: ArrayBuffer[] = [];
		for (let index = 0; index < metrics.length; index++) {
			const held = sampled.get(metrics[index]);
			if (held === undefined) continue;
			sampled.delete(metrics[index]); // a buffer listed twice fails the whole postMessage
			runs.push({ index, values: held.values, runs: held.runs, length: held.length });
			transfer.push(held.values.buffer as ArrayBuffer, held.runs.buffer as ArrayBuffer);
		}
		parentPort.postMessage({ type: ANALYTICS_REPORT_TYPE, report, runs }, transfer);
	} else void recordAnalytics({ report });
}

export async function recordHostname() {
	// Skip writes in read-only mode
	if (isReadOnlyMode()) return;
	const hostname = server.hostname;
	log.trace?.('recordHostname server.hostname:', hostname);
	const nodeId = stableNodeId(hostname);
	log.trace?.('recordHostname nodeId:', nodeId);
	const hostnamesTable = getAnalyticsHostnameTable();
	const hostnameRecord = {
		id: nodeId,
		hostname,
	};
	log.trace?.(`recordHostname storing hostname: ${JSON.stringify(hostnameRecord)}`);
	await (hostnamesTable as any).put(hostnameRecord.id, hostnameRecord);
}

export interface Metric {
	[key: string]: any;
}

function getHostNodeId(hostname: string) {
	let nodeId = nodeIds.get(hostname);
	if (nodeId) {
		log.trace?.('storeMetric cached nodeId:', nodeId);
		return nodeId;
	}
	nodeId = stableNodeId(hostname);
	log.trace?.('storeMetric new nodeId:', nodeId);
	nodeIds.set(hostname, nodeId);
	return nodeId;
}

function storeMetric(table: Table, metric: Metric) {
	// Skip writes in read-only mode
	if (isReadOnlyMode()) return;
	const nodeId = getHostNodeId(server.hostname);
	const metricValue = {
		id: [getNextMonotonicTime(), nodeId],
		...metric,
	};
	log.trace?.(`storing metric ${JSON.stringify(metricValue)}`);
	try {
		Promise.resolve(table.put(metricValue.id, metricValue)).catch(logMetricWriteError);
	} catch (error) {
		logMetricWriteError(error);
	}
}

function logMetricWriteError(error) {
	log[error?.statusCode === 503 ? 'debug' : 'warn']?.('Unable to save analytics metric', error);
}

interface ResourceUsage extends Partial<NodeJS.ResourceUsage> {
	time?: number;
	period?: number;
	cpuUtilization?: number;
	userCPUTime?: number;
	systemCPUTime?: number;
}

/** calculateCPUUtilization takes a ResourceUsage with at least userCPUTime &
 *  systemCPUTime set with millisecond values and a time period in milliseconds
 *  and returns the percentage of that time the CPU was being utilized as a
 *  decimal value between 0 and 1. So for example, 50% utilization will be
 *  returned as 0.5.
 */
export function calculateCPUUtilization(resourceUsage: ResourceUsage, period: number): number {
	const cpuTime = resourceUsage.userCPUTime + resourceUsage.systemCPUTime;
	log.trace?.(`calculateCPUUtilization cpuTime: ${cpuTime} period: ${period}`);
	return Math.round((cpuTime / period) * 100) / 100;
}

/** diffResourceUsage takes a ResourceUsage representing the last time we stored them and a new
 *  process.resourceUsage() return value and normalizes and diffs the two values to return the
 *  new values for this time period.
 */
export function diffResourceUsage(lastResourceUsage: ResourceUsage, resourceUsage: ResourceUsage): ResourceUsage {
	return {
		userCPUTime: resourceUsage.userCPUTime - (lastResourceUsage?.userCPUTime ?? 0),
		systemCPUTime: resourceUsage.systemCPUTime - (lastResourceUsage?.systemCPUTime ?? 0),
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
			metric: METRIC.TABLE_SIZE,
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

export function storeDBSizeMetrics(analyticsTable: Table, databases: Databases) {
	for (const [db, tables] of Object.entries(databases)) {
		try {
			const [firstTable] = Object.values(tables);
			const dbAuditSize = firstTable?.getAuditSize();
			if (dbAuditSize == null) {
				continue;
			}
			let metric;
			if (firstTable.primaryStore instanceof RocksDatabase) {
				const dbPath = firstTable.primaryStore.path;
				let dbSize = 0;
				for (const filename of fs.readdirSync(dbPath)) {
					if (filename.endsWith('.sst')) {
						dbSize += fs.statSync(join(dbPath, filename)).size;
					}
				}
				metric = {
					metric: METRIC.DATABASE_SIZE,
					database: db,
					size: dbSize,
					transactionLog: dbAuditSize,
				};
				storeMetric(analyticsTable, metric);
			} else {
				const dbTotalSize = fs.statSync(firstTable.primaryStore.path).size;
				const dbUsedSize = storeTableSizeMetrics(analyticsTable, db, tables);
				const dbFree = dbTotalSize - dbUsedSize;
				metric = {
					metric: METRIC.DATABASE_SIZE,
					database: db,
					size: dbTotalSize,
					used: dbUsedSize,
					free: dbFree,
					audit: dbAuditSize,
				};
				storeMetric(analyticsTable, metric);
			}
		} catch (error) {
			// a table or db was deleted, could get an error here
			log.warn?.(`Error getting DB size metrics`, error);
		}
	}
}

export async function storeVolumeMetrics(analyticsTable: Table, databases: Databases) {
	await Promise.all(
		Object.entries(databases).map(async ([db, tables]) => {
			try {
				const [firstTable] = Object.values(tables);
				const storageStats = await firstTable?.getStorageStats();
				if (!storageStats) {
					return;
				}
				const metric = {
					metric: METRIC.STORAGE_VOLUME,
					database: db,
					...storageStats,
				};
				storeMetric(analyticsTable, metric);
				log.trace?.(`db ${db} storage volume metrics: ${JSON.stringify(metric)}`);
			} catch (error) {
				// a table or db was deleted, could get an error here
				log.warn?.(`Error getting DB volume metrics`, error);
			}
		})
	);
}

// RocksDB stat names are kebab-case with a "rocksdb." prefix (e.g. "rocksdb.block.cache.hit");
// camelCase them to match the field shape used throughout systemInformation.
export function toRocksDBCamelCase(key: string): string {
	return key.replace(/^rocksdb\./, '').replace(/[-.]([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Every column family on the same physical RocksDB shares one Statistics object, so all ticker
// counters returned by getStats() — including memtableHit/memtableMiss — are DB-wide, not per-CF.
// Listing them as DB-level avoids emitting the same delta on every table row.
const ROCKSDB_DB_COUNTERS = [
	'bytesRead',
	'bytesWritten',
	'numberKeysRead',
	'numberKeysWritten',
	'blockCacheHit',
	'blockCacheMiss',
	'blockCacheDataHit',
	'blockCacheDataMiss',
	'blockCacheIndexHit',
	'blockCacheIndexMiss',
	'blockCacheFilterHit',
	'blockCacheFilterMiss',
	'stallMicros',
	'memtableHit',
	'memtableMiss',
	// Transaction log counters, summed across all of a database's logs by getStats(). The summed
	// roll-up rides on the db-level rocksdb-stats row; per-log detail lives on rocksdb-txnlog-stats.
	'txnlogBytesWritten',
	'txnlogTransactionsWritten',
] as const;
// Gauges are scalar values that are not cumulative. They go up and down over time.
const ROCKSDB_DB_GAUGES = [
	'blockCacheUsage',
	'blockCacheCapacity',
	'numRunningFlushes',
	// Transaction log gauges, summed across all of a database's logs by getStats().
	'txnlogLogCount',
	'txnlogFileCount',
	'txnlogTotalSizeBytes',
	'txnlogMappedBytes',
	'txnlogOverlayBytes',
	'txnlogActiveMaps',
	'txnlogPendingTransactions',
	'txnlogUncommittedTransactions',
	'txnlogReplayGapBytes',
] as const;
const ROCKSDB_TABLE_GAUGES = ['numRunningCompactions', 'compactionPending'] as const;

// Per-transaction-log stats (rocksdb-txnlog-stats metric), flattened from log.getStats(), one
// row per log. Sequence numbers, positions, and static config are intentionally dropped as noise
// (see normalizeTxnLogStats).
const ROCKSDB_TXNLOG_GAUGES = [
	'fileCount',
	'totalSizeBytes',
	'currentFileSize',
	'pendingTransactions',
	'uncommittedTransactions',
	'replayGapBytes',
	'memoryMappedBytes',
	'memoryOverlayBytes',
	'memoryActiveMaps',
	'purgeOldestFileAgeMs',
	'purgePurgeableFiles',
	'purgeRetainedUnflushedFiles',
] as const;
// Per-transaction-log lifetime counters (diffed to per-period rates).
const ROCKSDB_TXNLOG_COUNTERS = [
	'totalsTransactionsWritten',
	'totalsEntriesWritten',
	'totalsBytesWritten',
	'totalsRotations',
	'totalsWriteFailures',
] as const;

const lastRocksDBDbStats = new Map<string, Record<string, number>>();
// Per-log counter baselines, nested db name -> log name -> last normalized stats, so a database's
// log baselines can be pruned together when the database is dropped.
const lastRocksDBLogStats = new Map<string, Map<string, Record<string, number>>>();
let lastRocksDBStatsTime = 0;

export function diffRocksDBCounter(curr: number, last: number | undefined): number {
	// A negative delta means RocksDB itself reset the counter mid-process (e.g. an internal
	// statistics reset). Process restarts are handled separately because the module-level
	// last-stats maps are reinitialized, which takes the no-prior-reading path below.
	if (last === undefined || curr < last) return curr;
	return curr - last;
}

/**
 * Filter a raw RocksDB stats record to numeric scalar entries, camelCasing the keys.
 * Histogram entries (objects) are dropped — they don't fit the flat analytics row model.
 * @param raw - The raw RocksDB stats record to normalize.
 * @returns The normalized RocksDB stats record.
 */
export function normalizeRocksDBStats(raw: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	if (!raw) return out;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'number') out[toRocksDBCamelCase(key)] = value;
	}
	return out;
}

/**
 * Flattens a per-log TransactionLogStats snapshot to the flat numeric record used by analytics,
 * selecting only the performance- and resource-relevant fields. Sequence numbers, log positions,
 * the path, and static config are intentionally dropped — they carry no analytic signal as a
 * periodic time series (replayGapBytes already captures the meaningful flushed-vs-written gap).
 * @param raw - The raw per-log stats from log.getStats().
 * @returns The normalized per-log stats record.
 */
export function normalizeTxnLogStats(raw: TransactionLogStats): Record<string, number> {
	const out: Record<string, number> = {};
	if (!raw) return out;
	const setNumber = (key: string, value: unknown) => {
		if (typeof value === 'number') out[key] = value;
	};
	setNumber('fileCount', raw.fileCount);
	setNumber('totalSizeBytes', raw.totalSizeBytes);
	setNumber('currentFileSize', raw.currentFileSize);
	setNumber('pendingTransactions', raw.pendingTransactions);
	setNumber('uncommittedTransactions', raw.uncommittedTransactions);
	setNumber('replayGapBytes', raw.replayGapBytes);
	const { memory, purge, totals } = raw;
	if (memory) {
		setNumber('memoryMappedBytes', memory.mappedBytes);
		setNumber('memoryOverlayBytes', memory.overlayBytes);
		setNumber('memoryActiveMaps', memory.activeMaps);
	}
	if (purge) {
		setNumber('purgeOldestFileAgeMs', purge.oldestFileAgeMs);
		setNumber('purgePurgeableFiles', purge.purgeableFiles);
		setNumber('purgeRetainedUnflushedFiles', purge.retainedUnflushedFiles);
	}
	if (totals) {
		setNumber('totalsTransactionsWritten', totals.transactionsWritten);
		setNumber('totalsEntriesWritten', totals.entriesWritten);
		setNumber('totalsBytesWritten', totals.bytesWritten);
		setNumber('totalsRotations', totals.rotations);
		setNumber('totalsWriteFailures', totals.writeFailures);
	}
	return out;
}

/**
 * Gathers metrics for a RocksDB database.
 * @param dbName - The name of the database.
 * @param stats - The stats to build the metric from.
 * @param lastStats - The last stats to diff the stats from.
 * @param now - The current time.
 * @param period - The period to store the metrics for.
 */
export function buildRocksDBDbMetric(
	dbName: string,
	stats: Record<string, number>,
	lastStats: Record<string, number> | undefined,
	now: number,
	period: number | undefined
): Record<string, unknown> {
	const metric: Record<string, unknown> = {
		metric: METRIC.ROCKSDB_STATS,
		database: dbName,
		time: now,
	};
	if (period !== undefined) metric.period = period;
	for (const field of ROCKSDB_DB_COUNTERS) {
		metric[field] = diffRocksDBCounter(stats[field] ?? 0, lastStats?.[field]);
	}
	for (const field of ROCKSDB_DB_GAUGES) {
		metric[field] = stats[field] ?? 0;
	}
	return metric;
}

/**
 * Gathers metrics for a RocksDB table. Only gauges are reported per-table; ticker counters
 * are DB-wide (see ROCKSDB_DB_COUNTERS comment) and live on the DB-level metric.
 * @param dbName - The name of the database.
 * @param tableName - The name of the table.
 * @param stats - The stats to build the metric from.
 * @param now - The current time.
 * @param period - The period to store the metrics for.
 */
export function buildRocksDBTableMetric(
	dbName: string,
	tableName: string,
	stats: Record<string, number>,
	now: number,
	period: number | undefined
): Record<string, unknown> {
	const metric: Record<string, unknown> = {
		metric: METRIC.ROCKSDB_STATS,
		database: dbName,
		table: tableName,
		time: now,
	};
	if (period !== undefined) metric.period = period;
	for (const field of ROCKSDB_TABLE_GAUGES) {
		metric[field] = stats[field] ?? 0;
	}
	return metric;
}

/**
 * Gathers metrics for a single RocksDB transaction log (rocksdb-txnlog-stats). Counters are
 * diffed against the prior sample (like the DB-level counters); gauges pass through absolute.
 * Carries a `log` dimension alongside `database`.
 * @param dbName - The name of the database the log is attached to.
 * @param logName - The name of the transaction log.
 * @param stats - The normalized per-log stats.
 * @param lastStats - The previous sample's normalized stats, for diffing counters.
 * @param now - The current time.
 * @param period - The period to store the metrics for.
 */
export function buildRocksDBTxnLogMetric(
	dbName: string,
	logName: string,
	stats: Record<string, number>,
	lastStats: Record<string, number> | undefined,
	now: number,
	period: number | undefined
): Record<string, unknown> {
	const metric: Record<string, unknown> = {
		metric: METRIC.ROCKSDB_TXNLOG_STATS,
		database: dbName,
		log: logName,
		time: now,
	};
	if (period !== undefined) metric.period = period;
	for (const field of ROCKSDB_TXNLOG_COUNTERS) {
		metric[field] = diffRocksDBCounter(stats[field] ?? 0, lastStats?.[field]);
	}
	for (const field of ROCKSDB_TXNLOG_GAUGES) {
		metric[field] = stats[field] ?? 0;
	}
	return metric;
}

/**
 * Stores the RocksDB stats metrics for the given databases.
 * @param analyticsTable - The analytics table to store the metrics in.
 * @param databases - The databases to store the metrics for.
 * @param now - The current time.
 * @param period - The period to store the metrics for.
 */
export function storeRocksDBStatsMetrics(
	analyticsTable: Table,
	databases: Databases,
	now: number,
	period: number | undefined
) {
	for (const [db, tables] of Object.entries(databases)) {
		if (!tables) continue; // no tables or not loaded/initialized yet
		const tableEntries = Object.entries(tables);
		const [, firstTable] = tableEntries[0] ?? [];
		// Tables in a database share one root store; check the first to skip non-RocksDB databases.
		const rootStore = firstTable?.primaryStore;
		if (!(rootStore instanceof RocksDatabase)) continue;

		let firstNormalizedStats: Record<string, number> | undefined;
		for (const [tableName, tbl] of tableEntries) {
			try {
				const tableStats = normalizeRocksDBStats(tbl.primaryStore.getStats());
				if (!firstNormalizedStats) firstNormalizedStats = tableStats;
				const tableMetric = buildRocksDBTableMetric(db, tableName, tableStats, now, period);
				storeMetric(analyticsTable, tableMetric);
			} catch (error) {
				// A table may be removed mid-collection — keep iterating siblings.
				log.warn?.(`Error getting RocksDB stats for table ${db}.${tableName}`, error);
			}
		}

		if (firstNormalizedStats) {
			// Any table's getStats() returns the same DB-wide counters; reuse the first one's.
			const lastDbStats = lastRocksDBDbStats.get(db);
			// Skip the first sample for a db — counters are cumulative since process start,
			// so reporting them as a delta would produce a misleading spike.
			if (lastDbStats !== undefined) {
				const dbMetric = buildRocksDBDbMetric(db, firstNormalizedStats, lastDbStats, now, period);
				storeMetric(analyticsTable, dbMetric);
				log.trace?.(`db ${db} rocksdb stats metric: ${JSON.stringify(dbMetric)}`);
			}
			lastRocksDBDbStats.set(db, firstNormalizedStats);
		}

		// Per-transaction-log stats. Logs are attached at the database (root store) level, so we
		// enumerate them once per database rather than per table.
		let logNames: string[];
		try {
			logNames = rootStore.listLogs();
		} catch (error) {
			// The store may have been closed/dropped mid-cycle (e.g. "Database not open"); skip this
			// database's logs rather than letting the throw abort the whole analytics cycle.
			log.warn?.(`Error listing RocksDB logs for ${db}`, error);
			continue;
		}
		let logStatsByName = lastRocksDBLogStats.get(db);
		const seenLogs = new Set<string>();
		for (const logName of logNames) {
			seenLogs.add(logName);
			try {
				const logStats = normalizeTxnLogStats(rootStore.useLog(logName).getStats());
				const lastLogStats = logStatsByName?.get(logName);
				// Skip the first sample for a log — its counters are cumulative since the log was
				// created, so a delta-from-zero would produce a misleading spike (mirrors the
				// DB-level skip above).
				if (lastLogStats !== undefined) {
					const logMetric = buildRocksDBTxnLogMetric(db, logName, logStats, lastLogStats, now, period);
					storeMetric(analyticsTable, logMetric);
					log.trace?.(`db ${db} log ${logName} rocksdb txnlog metric: ${JSON.stringify(logMetric)}`);
				}
				if (!logStatsByName) {
					logStatsByName = new Map();
					lastRocksDBLogStats.set(db, logStatsByName);
				}
				logStatsByName.set(logName, logStats);
			} catch (error) {
				// A log may be removed mid-collection — keep iterating siblings.
				log.warn?.(`Error getting RocksDB stats for log ${db}.${logName}`, error);
			}
		}
		// Drop cached baselines for logs that no longer exist on this database.
		if (logStatsByName) {
			for (const cachedLog of logStatsByName.keys()) {
				if (!seenLogs.has(cachedLog)) logStatsByName.delete(cachedLog);
			}
		}
	}
}

/**
 * Drop cached counter readings for databases that no longer exist, to bound memory
 * growth across drop/recreate cycles and prevent stale baselines from producing wrong diffs.
 * @param databases - The databases to prune the stats cache for.
 */
function pruneRocksDBStatsCache(databases: Databases) {
	const activeDbs = new Set<string>(Object.keys(databases));
	for (const key of lastRocksDBDbStats.keys()) {
		if (!activeDbs.has(key)) lastRocksDBDbStats.delete(key);
	}
	for (const key of lastRocksDBLogStats.keys()) {
		if (!activeDbs.has(key)) lastRocksDBLogStats.delete(key);
	}
}

/**
 * Returns a Databases view that includes the `system` database as an enumerable property.
 * getDatabases() marks `system` non-enumerable so general consumers skip it; analytics
 * needs to iterate over it like any other database.
 */
function getDatabasesIncludingSystem(): Databases {
	const databases = getDatabases();
	if (!databases.system) return databases;
	const all: Databases = Object.create(null);
	Object.assign(all, databases);
	all.system = databases.system;
	return all;
}

/**
 * Total size of everything under `dirPath`, measured with the smallest footprint we can manage rather
 * than the fewest wall-clock seconds: this runs about every ten minutes (`analytics.aggregatePeriod`
 * 60s x `analytics.storageInterval` 10), so it can afford to be slow, and it shares the libuv thread
 * pool with everything else on this thread.
 *
 * Peak live set is O(directories): each directory streams through `opendir` instead of materializing a
 * dirent array, files are stat'd one at a time, and only the directory stack and a running total are
 * retained. The previous implementation fanned out over every entry in the tree with an unbounded
 * `Promise.all`, holding a path string, a dirent and a pending stat per file simultaneously — which
 * grew the main thread's heap until V8 aborted on a root with a large blob store (harper#2240).
 *
 * A per-file stat failure must not zero the tree: the previous `Promise.all` rejected on one bad stat
 * and the outer catch returned 0 for everything under `dirPath`, so a file removed mid-walk erased the
 * whole measurement.
 *
 * `statFile` is a test seam; production always uses `stat`.
 */
export async function getDirectorySizeAsync(
	dirPath: string,
	options?: { statFile?: (path: string) => Promise<{ size: number }> }
): Promise<number> {
	const statFile = options?.statFile ?? stat;
	const directories: string[] = [dirPath];
	let total = 0;
	let statFailures = 0;
	while (directories.length > 0) {
		const directory = directories.pop() as string;
		let handle;
		try {
			handle = await opendir(directory);
		} catch {
			continue; // may not exist or be inaccessible — contributes 0, as before
		}
		try {
			for await (const entry of handle) {
				const fullPath = join(directory, entry.name);
				if (entry.isDirectory()) {
					directories.push(fullPath);
					continue;
				}
				if (!entry.isFile()) continue;
				try {
					total += (await statFile(fullPath)).size;
				} catch {
					statFailures++;
				}
			}
		} catch {
			// Iteration failed partway (permissions, removal mid-walk). `for await` does not run the
			// iterator's return() when next() rejects, so close explicitly rather than relying on Dir
			// internals; a double close throws ERR_DIR_CLOSED, hence the swallow.
			await handle.close().catch(() => {});
		}
	}
	if (statFailures > 0) {
		log.debug?.(`Storage metric: ${statFailures} file(s) could not be stat'd; reported size is an under-count`);
	}
	return total;
}

const DEFAULT_STORAGE_INTERVAL = 10;
let nodeStorageInterval = DEFAULT_STORAGE_INTERVAL;
let nodeStorageCycleCount = 0;
let nodeStorageWalkInFlight = false;

async function storeNodeStorageMetric(analyticsTable: Table) {
	if (nodeStorageInterval <= 0 || ++nodeStorageCycleCount % nodeStorageInterval !== 1) return;
	// A walk of a large root can outlast the cadence; overlapping walks would multiply the peak. Logged
	// so a gap in the series reads as "measurement is not keeping up" rather than "storage stopped".
	if (nodeStorageWalkInFlight) {
		log.debug?.('Skipping node storage metric: the previous walk is still running');
		return;
	}
	nodeStorageWalkInFlight = true;
	try {
		const size = await getDirectorySizeAsync(getHdbBasePath());
		storeMetric(analyticsTable, {
			metric: METRIC.NODE_STORAGE,
			size,
		});
	} catch (error) {
		log.warn?.('Error getting node storage metric', error);
	} finally {
		nodeStorageWalkInFlight = false;
	}
}

// Upper bound on the cold-start reverse scan that seeds `lastAggregationTime`. A healthy node's
// newest record matches at depth 1; this cap only engages in the pathological no-matching-record
// case, keeping the one-time main-thread decode cost bounded instead of O(table size). See #1538.
const MAX_LAST_AGGREGATION_SCAN = 1000;
// Time of this node's last completed aggregation, tracked in O(1) across cycles within a process.
let lastAggregationTime: number | undefined;
// Resume point into the raw analytics table: it moves only over records a cycle read, so it is not
// a clock and never passes an unread report.
let rawCursor: number | undefined;
// A cycle stopped at its window edge with raw records still behind it, so the next one skips the
// cadence guard and drains the next window.
let aggregationBehind = false;

/**
 * Find the time of the local node's most recent aggregation record by scanning back from the
 * newest entry. The scan is BOUNDED to `maxScan` records: if no composite-id record for this node
 * sits near the top — e.g. legacy scalar ids carried across an upgrade, or a node that has never
 * completed an aggregation — an unbounded reverse scan would decode the entire table with msgpackr
 * on the main thread, starving TLS handshakes and other main-thread work. Returns `undefined` when
 * no match is found within the bound, so the caller falls back to aggregating recent raw data
 * rather than scanning to EOF. Exported for testing. See #1538.
 */
export function findLastAggregationTime(
	primaryStore: { getRange(options: object): Iterable<{ value?: any }> },
	localNodeId: number,
	maxScan: number = MAX_LAST_AGGREGATION_SCAN
): number | undefined {
	let scanned = 0;
	for (const entry of primaryStore.getRange({ start: Infinity, end: false, reverse: true })) {
		if (entry.value?.time && Array.isArray(entry.value.id) && entry.value.id[1] === localNodeId)
			return entry.value.time;
		if (++scanned >= maxScan) break;
	}
	return undefined;
}

let aggregationRunning = false;

/** Two cycles reading the same cursor roll the same window up twice, and the scheduler does not
 * await its callback. */
export async function runAggregationCycle(fromPeriod, toPeriod = 60000) {
	if (aggregationRunning) return;
	aggregationRunning = true;
	try {
		await aggregation(fromPeriod, toPeriod);
	} finally {
		aggregationRunning = false;
	}
}

// A mean of per-sample peaks is not a peak, so peak-named measures fold with max.
const MAX_MEASURE_NAME = /^max[A-Z]/;
const PER_THREAD_METRICS = new Map<string, string>([['duration', METRIC.DURATION_BY_THREAD]]);

async function aggregation(fromPeriod, toPeriod = 60000) {
	const rawAnalyticsTable = getRawAnalyticsTable();
	const analyticsTable = getAnalyticsTable();
	const taskQueueLatency = (async () => {
		const start = performance.now();
		// measure how long it takes to enqueue and get a callback from a simple/fast task:
		// The result is discarded — only the round trip is being measured — so a missing file is not a
		// failure. It rejects whenever the probe races a rotation, which the write-path size guard
		// makes a routine event rather than a once-a-minute one, and an unhandled rejection here takes
		// the process down over a latency measurement.
		await stat(getLogFilePath()).catch(() => {});
		const delay = performance.now() - start;
		if (delay > 5000) {
			log.warn?.('Unusually high task queue latency on the main thread of ' + Math.round(delay) + 'ms');
		}
		return delay;
	})();
	const localNodeId = getHostNodeId(server.hostname);
	// Find the time of this node's last aggregation. In steady state this is tracked in O(1) via
	// `lastAggregationTime` (set at the end of every completed run below), so cycles after the
	// first never touch the table. On the first cycle after boot we seed it once from the table
	// via a bounded reverse scan (see findLastAggregationTime). Caching the seeded value keeps
	// the next cycle O(1) even when this run early-returns below as "too recent"; a bound-hit
	// (no match) leaves it undefined so we don't early-return, proceed to aggregate, and stamp the
	// cadence marker at the end of the cycle instead (#1538).
	let lastForPeriod = lastAggregationTime;
	if (lastForPeriod === undefined) {
		lastForPeriod = findLastAggregationTime(analyticsTable.primaryStore, localNodeId);
		if (lastForPeriod !== undefined) {
			lastAggregationTime = lastForPeriod;
			rawCursor ??= lastForPeriod;
		}
	}
	// was the last aggregation too recent to calculate a whole period?
	if (!aggregationBehind && lastForPeriod !== undefined && Date.now() - toPeriod < lastForPeriod) return;
	let firstForPeriod;
	const aggregateActions = new Map();
	const distributions = new Map();
	const threadsToAverage = [];
	// A measure's weight is the count of only the samples that carried it, per action or thread record.
	const measureCounts = new Map<object, Record<string, number>>();
	let lastTime: number | undefined;
	let stoppedAtWindowEdge = false;
	for (const { key, value } of rawAnalyticsTable.primaryStore.getRange({
		start: rawCursor || false,
		exclusiveStart: true,
		end: Infinity,
	})) {
		if (!value) continue;
		if (firstForPeriod) {
			if (key > firstForPeriod + toPeriod) {
				stoppedAtWindowEdge = true;
				break; // outside the period of interest
			}
		} else firstForPeriod = key;
		lastTime = key;
		const { metrics, threadId } = value;
		const aggregateEntry = (entry) => {
			let {
				path,
				method,
				type,
				metric,
				count,
				total,
				distribution,
				threads: _threads,
				threadId: _threadId,
				perThread,
				...measures
			} = entry;
			if (!count) count = 1;
			let key = metric + (path ? '-' + path : '');
			if (method !== undefined) key += '-' + method;
			if (type !== undefined) key += '-' + type;
			// No ordinary key ends in NUL and digits: HTTP methods are token characters, and an operation
			// key, whose action name a request body chooses, always ends in `-operation`.
			if (perThread) key += '\0' + threadId;
			let action = aggregateActions.get(key);
			if (entry.cumulative) {
				if (!action || entry.sampledAt >= action.sampledAt) {
					const latest = { ...entry, period: toPeriod, thread: threadId };
					delete latest.perThread;
					delete latest.threadId;
					aggregateActions.set(key, latest);
				}
				return;
			}
			if (action) {
				const byThread = Boolean(action.byThread);
				if (byThread) {
					const actionForThread = action.threads[threadId];
					if (actionForThread) action = actionForThread;
					else {
						action.threads[threadId] = { ...measures };
						return;
					}
				}
				if (!action.count) action.count = 1;
				let counts = measureCounts.get(action);
				if (!counts) {
					// Until its first fold, a target holds only its first sample.
					counts = Object.create(null);
					for (const measureName in action) {
						if (typeof action[measureName] === 'number') counts[measureName] = action.count;
					}
					measureCounts.set(action, counts);
				}
				for (const measureName in measures) {
					const value = measures[measureName];
					if (typeof value !== 'number') continue;
					const measureCount = counts[measureName];
					if (measureCount === undefined) action[measureName] = value;
					else if (MAX_MEASURE_NAME.test(measureName)) action[measureName] = Math.max(action[measureName], value);
					else action[measureName] = (action[measureName] * measureCount + value * count) / (measureCount + count);
					counts[measureName] = (measureCount ?? 0) + count;
				}
				action.count += count;
				// A thread's record is built from measures alone, so it has no total to add to.
				if (total >= 0 && !byThread) {
					action.total += total;
					action.ratio = action.total / action.count;
				}
			} else {
				action = { period: toPeriod, ...entry };
				delete action.distribution;
				delete action.threadId;
				aggregateActions.set(key, action);
				if (perThread) {
					delete action.perThread;
					action.thread = threadId;
				} else if (action.byThread) {
					action.threads = [];
					action.threads[threadId] = { ...measures };
					threadsToAverage.push(action);
				}
			}
			if (Array.isArray(distribution)) {
				distribution = distribution.flatMap((entry) =>
					typeof entry === 'number'
						? [{ value: entry, count: 1 }]
						: typeof entry?.value === 'number' && Number.isInteger(entry.count) && entry.count > 0
							? [entry]
							: []
				);
				const existingDistribution = distributions.get(key);
				if (!existingDistribution) distributions.set(key, distribution);
				else {
					existingDistribution.push(...distribution);
				}
			}
		};
		for (const entry of metrics || []) {
			aggregateEntry(entry);
			const perThreadMetric = PER_THREAD_METRICS.get(entry.metric);
			if (perThreadMetric)
				aggregateEntry({ metric: perThreadMetric, count: entry.count, mean: entry.mean, perThread: true });
		}
		await rest();
	}
	// Peak-named measures sum per-thread peaks, which bounds concurrent depth only over intervals that
	// every relevant thread's samples fully cover; the peaks need not coincide.
	for (const entry of threadsToAverage) {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		let { path, method, type, metric, count, total, distribution, threads, period, ...measures } = entry;
		threads = threads.filter((thread) => thread);
		for (const measureName in measures) {
			if (typeof entry[measureName] === 'number') entry[measureName] = 0;
		}
		// A thread can carry measures the entry's first sample lacked.
		for (const thread of threads) {
			for (const measureName in thread) {
				if (measureName === 'period') continue;
				const value = thread[measureName];
				if (typeof value === 'number')
					entry[measureName] = (typeof entry[measureName] === 'number' ? entry[measureName] : 0) + value;
			}
		}
		entry.count = threads.length;
		delete entry.threads;
		delete entry.byThread;
	}
	for (const [key, distribution] of distributions) {
		// now iterate through the distributions finding the close bin to each percentile and interpolating the position in that bin
		try {
			takePercentiles(aggregateActions.get(key), distribution);
		} catch (error) {
			log.warn?.('Unable to aggregate the percentiles of', key, error);
		}
	}
	let hasUpdates;
	for (const [, value] of aggregateActions) {
		value.time = lastTime;
		storeMetric(analyticsTable, value);
		hasUpdates = true;
	}
	if (hasUpdates) {
		for (const listener of analyticsAggregateListeners) {
			listener(aggregateActions.values());
		}
	}
	const now = Date.now();
	const { idle, active } = (globalThis as any).Bun
		? { idle: 0, active: 0 }
		: (performance as any).eventLoopUtilization();
	// don't record boring entries
	if (hasUpdates || active * 10 > idle) {
		const value = {
			metric: METRIC.MAIN_THREAD_UTILIZATION,
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
	const resourceUsage = process.resourceUsage() as ResourceUsage;
	resourceUsage.time = now;
	// normalize to milliseconds
	resourceUsage.userCPUTime = resourceUsage.userCPUTime / 1000;
	resourceUsage.systemCPUTime = resourceUsage.systemCPUTime / 1000;
	log.trace?.(`process.resourceUsage: ${JSON.stringify(resourceUsage)}`);
	const currentResourceUsage = diffResourceUsage(lastResourceUsage, resourceUsage);
	log.trace?.(`diffed resourceUsage: ${JSON.stringify(currentResourceUsage)}`);
	currentResourceUsage.time = now;
	currentResourceUsage.period = lastResourceUsage.time ? now - lastResourceUsage.time : toPeriod;
	currentResourceUsage.cpuUtilization = calculateCPUUtilization(currentResourceUsage, currentResourceUsage.period);
	const cruMetric = {
		metric: METRIC.RESOURCE_USAGE,
		...currentResourceUsage,
	};
	storeMetric(analyticsTable, cruMetric);
	lastResourceUsage = resourceUsage;
	// The cursor may only pass records this cycle read, and nothing reads below it again: the scan
	// covers one `toPeriod` window, and a raw report whose `put` has not committed is invisible to
	// it however recent its key is. An empty scan therefore leaves the cursor where it was.
	if (lastTime !== undefined) rawCursor = lastTime;
	aggregationBehind = stoppedAtWindowEdge;
	lastAggregationTime = now;

	// `system` is set as non-enumerable on the object returned by getDatabases() so most
	// callers skip it; for analytics we want it included, so build a view where it's enumerable.
	const databases = getDatabasesIncludingSystem();

	// database-size & table-size metrics
	storeDBSizeMetrics(analyticsTable, databases);

	// database storage volume metrics
	await storeVolumeMetrics(analyticsTable, databases);

	// rocksdb engine stats (only for RocksDB-backed databases)
	const rocksDBPeriod = lastRocksDBStatsTime ? now - lastRocksDBStatsTime : undefined;
	storeRocksDBStatsMetrics(analyticsTable, databases, now, rocksDBPeriod);
	pruneRocksDBStatsCache(databases);
	lastRocksDBStatsTime = now;

	// node storage metric (total HDB directory size)
	await storeNodeStorageMetric(analyticsTable);
}
function takePercentiles(action: any, distribution: Array<{ value: number; count: number }>) {
	distribution.sort((a, b) => (a.value > b.value ? 1 : -1));
	let binTotal = 0;
	for (const bin of distribution) binTotal += bin.count;
	if (binTotal === 0) return;
	const count = binTotal - 1;
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
		percentiles.push(bin.value - ((bin.value - previousBin.value) * (countPosition - nextTargetCount)) / bin.count);
	}
	const [p1, p10, p25, median, p75, p90, p95, p99, p999] = percentiles;
	Object.assign(action, { p1, p10, p25, median, p75, p90, p95, p99, p999 });
}

let lastIdle = 0;
let lastActive = 0;
let lastResourceUsage: ResourceUsage = {
	userCPUTime: 0,
	systemCPUTime: 0,
};

const rest = () => new Promise(setImmediate);

async function cleanupTable(kind: string, cleanup: () => Promise<void>): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		log.warn?.(`Cleaning up ${kind} analytics failed`, error);
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

if (!parentPort) onMessageByType(ANALYTICS_REPORT_TYPE, recordAnalytics);
export const recordAnalyticsReportForTests = (message: any, worker?: any) => recordAnalytics(message, worker);
let scheduledTasksRunning;
function startScheduledTasks() {
	scheduledTasksRunning = true;
	nodeStorageInterval = envGet(CONFIG_PARAMS.ANALYTICS_STORAGEINTERVAL) ?? DEFAULT_STORAGE_INTERVAL;
	const AGGREGATE_PERIOD = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) * 1000;
	if (AGGREGATE_PERIOD > 0) {
		// Clamp raw retention to at least one full aggregation period so raw records
		// are never deleted before they can be rolled up.
		const rawRetentionMs = Math.max(envGet(CONFIG_PARAMS.ANALYTICS_RAWRETENTIONMS) ?? RAW_EXPIRATION, AGGREGATE_PERIOD);
		const aggregateRetentionMs = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATERETENTIONMS) ?? AGGREGATE_EXPIRATION;
		setInterval(
			async () => {
				try {
					await runAggregationCycle(analyticsDelay, AGGREGATE_PERIOD);
				} catch (error) {
					log.warn?.('Analytics aggregation failed', error);
					return;
				}
				await cleanupTable('raw', () => cleanupExpiredAnalytics(getRawAnalyticsTable(), rawRetentionMs));
				// 0 means "keep forever" — skip aggregate cleanup, matching storageInterval: 0 convention
				if (aggregateRetentionMs) {
					await cleanupTable('aggregate', () => cleanupExpiredAnalytics(getAnalyticsTable(), aggregateRetentionMs));
				}
			},
			Math.max(0, Math.min(AGGREGATE_PERIOD / 2, MAX_SET_TIMEOUT_MS))
		).unref();
	}
}

function isSampleRuns(held: any, entry: any): held is SampleRuns {
	return (
		Number.isInteger(entry?.count) &&
		held.values instanceof Float32Array &&
		(held.runs instanceof Uint16Array || held.runs instanceof Uint32Array) &&
		Number.isInteger(held.length) &&
		held.length > 0 &&
		held.length <= held.values.length &&
		held.length <= held.runs.length
	);
}

function withDistribution(entry: any, distribution: Distribution) {
	const settled: any = {};
	for (const key in entry) {
		if (key === 'distribution') continue; // a worker listener's own, which the runs replace
		settled[key] = entry[key];
		if (key === 'mean') settled.distribution = distribution;
	}
	settled.distribution ??= distribution;
	return settled;
}

let totalBytesProcessed = 0;
const lastUtilizations = new Map();
const LOG_ANALYTICS = false; // TODO: Make this a config option if we really want this
function recordAnalytics(message, worker?) {
	// Skip writes in read-only mode
	if (isReadOnlyMode()) return;
	const report = message.report;
	report.threadId = worker?.threadId || threadId;
	let runsByEntry: Map<any, SampleRuns> | undefined;
	let runs = 0;
	if (Array.isArray(message.runs)) {
		for (const held of message.runs) {
			const entry = report.metrics[held?.index];
			if (!isSampleRuns(held, entry)) {
				if (entry !== null && typeof entry === 'object') delete entry.distribution;
				continue;
			}
			(runsByEntry ??= new Map()).set(entry, held);
			runs += Math.max(held.values.length, held.runs.length);
		}
	}
	// Add system information stats as well
	let retained;
	let listedPositions = 0;
	for (let i = 0; i < report.metrics.length; i++) {
		const metric = report.metrics[i];
		if (metric.metric === METRIC.FULL_TEXT && !acceptsFullTextTelemetryRow(metric)) {
			retained ??= report.metrics.slice(0, i);
			continue;
		}
		if (runsByEntry?.has(metric)) listedPositions++;
		retained?.push(metric);
	}
	if (retained) report.metrics = retained;
	if (worker && !isBun) {
		report.metrics.push({
			metric: METRIC.UTILIZATION,
			...worker.performance.eventLoopUtilization(lastUtilizations.get(worker)),
		});
		lastUtilizations.set(worker, worker.performance.eventLoopUtilization());
	}
	const now = performance.now();
	if (
		runsByEntry !== undefined &&
		((pendingSummaries.length > 0 && now - pendingSummaries[0].receivedAt > summaryBehindMs) ||
			pendingRuns + runs > maxPendingRuns)
	) {
		for (const entry of runsByEntry.keys()) delete entry.distribution; // a worker listener's, from no samples
		runsByEntry = undefined;
		runs = 0;
		if (now - droppedWarningAt >= DROPPED_WARNING_INTERVAL_MS) {
			droppedWarningAt = now;
			log.warn?.('Analytics summaries are behind; storing reports without distributions until they catch up');
		}
	}
	if (runsByEntry === undefined && pendingSummaries.length === 0)
		return storeReport(report, worker ? undefined : analyticsGeneration);
	const bytes =
		estimateReportBytes(report) +
		(runsByEntry === undefined ? 0 : listedPositions * IDEAL_PERCENTILES.length * OBJECT_BYTES);
	if (!admitsWaiting(pendingSummaries.length + reportWrites.size, pendingSummaryBytes + reportWriteBytes + bytes))
		return warnDropped('Analytics reports are backing up behind summaries; dropping reports until they catch up');
	pendingRuns += runs;
	pendingSummaryBytes += bytes;
	return new Promise((done) => {
		pendingSummaries.push({
			report,
			runsByEntry,
			next: 0,
			runs,
			bytes,
			receivedAt: now,
			generation: worker ? undefined : analyticsGeneration,
			done,
		});
		// from a microtask, so the drain's own clearing of `summarizing` cannot precede this assignment
		summarizing ??= Promise.resolve().then(summarizePending);
	});
}

const pendingSummaries: Array<{
	report: any;
	runsByEntry: Map<any, SampleRuns> | undefined;
	summarized?: Map<any, any>;
	next: number;
	runs: number;
	bytes: number;
	receivedAt: number;
	generation: number | undefined;
	done: (written?: any) => void;
}> = [];
const SUMMARY_BEHIND_MS = 2000;
const MAX_PENDING_RUNS = 1 << 24;
let summaryBehindMs = SUMMARY_BEHIND_MS;
let maxPendingRuns = MAX_PENDING_RUNS;
export function setSummaryLimitsForTests(
	runs = MAX_PENDING_RUNS,
	behindMs = SUMMARY_BEHIND_MS,
	writes = MAX_REPORT_WRITES,
	writeBytes = MAX_REPORT_WRITE_BYTES
) {
	maxPendingRuns = runs;
	summaryBehindMs = behindMs;
	maxReportWrites = writes;
	maxReportWriteBytes = writeBytes;
	droppedWarningAt = unwrittenWarningAt = -Infinity;
}
let pendingRuns = 0;
let pendingSummaryBytes = 0;
const DROPPED_WARNING_INTERVAL_MS = 60_000;
let droppedWarningAt = -Infinity;
const SUMMARY_TURN_MS = 2;
let summarizing: Promise<void> | undefined;
async function summarizePending() {
	let turnStart = performance.now();
	try {
		while (pendingSummaries.length > 0) {
			if (performance.now() - turnStart >= SUMMARY_TURN_MS) {
				await rest();
				turnStart = performance.now();
			}
			const pending = pendingSummaries[0];
			const metrics = pending.report.metrics;
			try {
				while (pending.runsByEntry !== undefined && pending.next < metrics.length) {
					const index = pending.next++;
					const entry = metrics[index];
					const summarized = pending.summarized?.get(entry);
					if (summarized !== undefined) {
						metrics[index] = summarized; // a listener put this entry in the array twice
						continue;
					}
					const held = pending.runsByEntry.get(entry);
					if (held === undefined) continue;
					try {
						const { values, runs, length } = held;
						let total = 0;
						for (let run = 0; run < length; run++) total += runs[run];
						if (total !== entry.count) throw new Error(`${length} runs hold ${total} samples, not ${entry.count}`);
						const steps = distributionSteps(values, runs, length, entry.count);
						let step = steps.next();
						while (!step.done) {
							if (performance.now() - turnStart >= SUMMARY_TURN_MS) {
								await rest();
								turnStart = performance.now();
							}
							step = steps.next();
						}
						metrics[index] = withDistribution(entry, step.value);
						(pending.summarized ??= new Map()).set(entry, metrics[index]);
					} catch (error) {
						delete entry.distribution;
						log.error?.('Unable to summarize a worker analytics metric', error);
					}
					if (performance.now() - turnStart >= SUMMARY_TURN_MS) {
						await rest();
						turnStart = performance.now();
					}
				}
				pendingSummaries.shift();
				pendingRuns -= pending.runs;
				pendingSummaryBytes -= pending.bytes;
				if (pending.generation !== undefined && pending.generation !== analyticsGeneration) {
					pending.done();
					continue;
				}
				pending.done(storeReport(pending.report, pending.generation));
			} catch (error) {
				if (pendingSummaries[0] === pending) {
					pendingSummaries.shift();
					pendingRuns -= pending.runs;
					pendingSummaryBytes -= pending.bytes;
				}
				log.error?.('Unable to record a worker analytics report', error);
				pending.done();
			}
		}
	} finally {
		summarizing = undefined;
	}
}

/** Logs a refusal instead of rejecting, as storeMetric does: a worker's report has no caller to handle it */
function storeReport(report: any, generation?: number) {
	// a wedged commit would otherwise hold every later report behind it, whole, for as long as it lasts
	const bytes = estimateReportBytes(report);
	if (!admitsWaiting(reportWrites.size, reportWriteBytes + bytes))
		return warnDropped('Analytics reports are not reaching storage; dropping reports until earlier writes complete');
	let written;
	try {
		const store = getRawAnalyticsTable().primaryStore;
		if (store.putOffThread) {
			const write = () =>
				generation === undefined || generation === analyticsGeneration
					? store.putOffThread(stampReport(report), report)
					: undefined;
			written = reportWriteInFlight ? reportWriteInFlight.then(write) : write();
		} else written = store.put(stampReport(report), report);
	} catch (error) {
		logMetricWriteError(error);
	}
	if (!scheduledTasksRunning) startScheduledTasks();
	if (LOG_ANALYTICS) lastAppend = logAnalytics(report);
	if (!written?.then) return written;
	const settled = written.then(undefined, logMetricWriteError);
	reportWriteInFlight = settled;
	reportWrites.add(settled);
	reportWriteBytes += bytes;
	void settled.then(() => {
		reportWrites.delete(settled);
		reportWriteBytes -= bytes;
		if (reportWriteInFlight === settled) reportWriteInFlight = undefined;
	});
	return settled;
}
/** One report always fits, or a report larger than the bound could never be written */
function admitsWaiting(reports: number, bytes: number) {
	return reports === 0 || (reports < maxReportWrites && bytes <= maxReportWriteBytes);
}
function warnDropped(message: string) {
	const now = performance.now();
	if (now - unwrittenWarningAt >= DROPPED_WARNING_INTERVAL_MS) {
		unwrittenWarningAt = now;
		log.warn?.(message);
	}
}
function stampReport(report: any) {
	for (const metric of report.metrics)
		if (metric.metric === 'bytes-sent') totalBytesProcessed += metric.mean * metric.count;
	report.totalBytesProcessed = totalBytesProcessed;
	return (report.id = getNextMonotonicTime());
}
/** Overestimates the heap a waiting report holds (measured, an entry is about 220 bytes beside its fields); a nested object counts 64 bytes whatever it holds */
function estimateReportBytes(report: any) {
	let bytes = 0;
	for (const metric of report.metrics) {
		bytes += REPORT_ENTRY_BYTES;
		for (const key in metric) {
			const value = metric[key];
			if (typeof value === 'string') bytes += value.length * 2;
			else if (typeof value === 'object' && value !== null)
				bytes += ArrayBuffer.isView(value)
					? value.buffer.byteLength
					: (Array.isArray(value) ? value.length : 1) * OBJECT_BYTES;
		}
	}
	return bytes;
}
const REPORT_ENTRY_BYTES = 256;
const OBJECT_BYTES = 64;
const reportWrites = new Set<Promise<unknown>>();
const MAX_REPORT_WRITES = 1000;
const MAX_REPORT_WRITE_BYTES = 1 << 26;
let maxReportWrites = MAX_REPORT_WRITES;
let maxReportWriteBytes = MAX_REPORT_WRITE_BYTES;
let reportWriteBytes = 0;
let unwrittenWarningAt = -Infinity;
let reportWriteInFlight: Promise<unknown> | undefined;
let lastAppend;
let analyticsLog;
const MAX_ANALYTICS_SIZE = 1000000;
async function logAnalytics(report) {
	await lastAppend;
	if (!analyticsLog) {
		const logDir = dirname(getLogFilePath());
		try {
			analyticsLog = await open(join(logDir, 'analytics.log'), 'r+');
		} catch {
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

export function onAnalyticsAggregate(callback) {
	if (callback) {
		analyticsAggregateListeners.push(callback);
	}
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

server.recordAnalytics = recordAction;
