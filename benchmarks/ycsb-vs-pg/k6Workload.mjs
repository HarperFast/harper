// One phase of a sample, run by k6 for k6Driver.mts: the load, the read-all pass, or a run of a workload.
// Keys, op mix, records and links all come from ../ycsb/workload.mts. k6 cannot load .mts, so k6Driver.mts
// puts that module, type-stripped, in front of this file and drops the import below.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import {
	KeyState,
	WORKLOADS,
	buildPicker,
	buildRecord,
	executeOp,
	formatKey,
	getValuePool,
	pickOp,
	useValuePool,
} from '../ycsb/workload.mts';

// eslint-disable-next-line no-undef -- k6 defines __ENV
const phase = JSON.parse(__ENV.YCSB_PHASE);
const OP_TYPES = ['read', 'update', 'insert', 'scan', 'rmw', 'inspect', 'chain'];
const SUMMARY_MARKER = 'YCSB_K6_SUMMARY ';

const opLatency = Object.fromEntries(OP_TYPES.map((type) => [type, new Trend(`ycsb_${type}`, true)]));
// Measured runs count their ops in opLatency; this counts the load's and read-all's.
const completedKeys = new Counter('ycsb_keys');
const failedOps = new Counter('ycsb_errors');

export const options = {
	scenarios: {
		ycsb: {
			executor: 'shared-iterations',
			vus: phase.vus,
			iterations: phase.iterations,
			maxDuration: phase.maxDuration,
		},
	},
	setupTimeout: phase.controlTimeout,
	teardownTimeout: phase.controlTimeout,
	summaryTrendStats: ['count', 'min', 'max', 'avg', 'p(50)', 'p(95)', 'p(99)', 'p(99.9)'],
	discardResponseBodies: true,
	// One series per metric: the default url and name tags would make one per key.
	systemTags: [],
};

const workload = phase.workload ? WORKLOADS[phase.workload] : undefined;
const picker = workload ? buildPicker(phase.mix ?? workload.mix) : undefined;
const mix = picker?.map((op) => op.type) ?? [];
// Built once per k6 process (SharedArray runs the callback once), before any VU is measured.
if (phase.phase === 'load' || mix.includes('update') || mix.includes('insert') || mix.includes('rmw')) {
	useValuePool(new SharedArray('ycsb value pool', () => [getValuePool()])[0]);
}

const authHeaders = phase.authorization ? { authorization: phase.authorization } : {};
const bodyHeaders = { ...authHeaders, 'content-type': 'application/json' };
const requestParams = (headers) => ({ headers, timeout: phase.requestTimeout });
const plainParams = requestParams(authHeaders);
const bodyParams = requestParams(bodyHeaders);
const callerParams = Object.fromEntries(
	Object.entries(phase.callerAuthorizations ?? {}).map(([caller, authorization]) => [
		caller,
		requestParams({ authorization }),
	])
);

// An op's latency: the time its requests spent on the wire and in the server (send, wait, receive).
// Timing the op in JavaScript instead would add this interpreter's own cost, tens of µs per op.
let opMs = 0;

function send(method, path, body, expectedStatus, params) {
	const response = http.request(method, phase.baseUrl + path, body, params);
	opMs += response.timings.duration;
	const ok =
		expectedStatus === undefined ? response.status >= 200 && response.status < 300 : response.status === expectedStatus;
	if (!ok) throw new Error(`${method} ${path} -> ${response.status || response.error}`);
}

// The same requests and status rules as ../ycsb/restClient.mts.
const recordPath = (key) => `/${phase.table}/${key}`;
const executor = {
	read: (key) => send('GET', recordPath(key), null, undefined, plainParams),
	insert: (key, record) => send('PUT', recordPath(key), JSON.stringify(record), undefined, bodyParams),
	update: (key, record) => send('PUT', recordPath(key), JSON.stringify(record), undefined, bodyParams),
	readModifyWrite(key, record) {
		send('GET', recordPath(key), null, undefined, plainParams);
		send('PUT', recordPath(key), JSON.stringify(record), undefined, bodyParams);
	},
	scan: (startKey, count) =>
		send('GET', `/${phase.table}/?id>=${startKey}&limit(${count})`, null, undefined, plainParams),
	inspect(key, caller, forbidden) {
		let params = requestParams({ ...authHeaders, 'x-caller': caller });
		if (phase.callerAuthorizations) {
			params = callerParams[caller];
			if (!params) throw new Error(`no credential for inspect caller ${caller}`);
		}
		send('GET', `/inspect/${key}`, null, forbidden ? 403 : 200, params);
	},
	chain: (key, hops) => send('GET', `/chain/${key}?hops=${hops}`, null, 200, plainParams),
};

let reportedError = false;
function failed(error) {
	failedOps.add(1);
	if (!reportedError) {
		reportedError = true;
		console.warn(`vu ${exec.vu.idInTest}: first failed op: ${error.message}`);
	}
}

// Per VU, built on its first iteration: its id, which picks its insert range, is unknown at init.
let keys;

export default async function () {
	if (phase.phase !== 'run') {
		const index = phase.from + exec.scenario.iterationInTest;
		const key = formatKey(index, phase.keyWidth);
		try {
			if (phase.phase === 'load') {
				executor.insert(key, buildRecord(phase.shape, { index, keyCount: phase.records, keyWidth: phase.keyWidth }));
			} else {
				executor.read(key);
			}
			completedKeys.add(1);
		} catch (error) {
			failed(error);
		}
		return;
	}
	keys ??= new KeyState({
		distribution: phase.distribution ?? workload.distribution,
		initialKeyCount: phase.records,
		keyWidth: phase.keyWidth,
		shape: phase.shape,
		maxScanLength: phase.maxScanLength,
		insertRange: { offset: exec.vu.idInTest - 1, stride: phase.vus },
	});
	const type = pickOp(picker);
	opMs = 0;
	try {
		await executeOp(type, executor, keys, workload.chainHops ?? 0);
		opLatency[type].add(opMs);
	} catch (error) {
		failed(error);
	}
}

// The harness opens its measured window when setup returns and closes it when teardown starts.
function control(step) {
	const response = http.get(`${phase.control}/${step}`, { timeout: phase.controlTimeout, responseType: 'text' });
	if (response.status !== 200)
		exec.test.abort(`the harness answered ${step} with ${response.status}: ${response.body}`);
}

export function setup() {
	control('ready');
}

export function teardown() {
	control('done');
}

export function handleSummary(data) {
	const count = (name) => data.metrics[name]?.values.count ?? 0;
	const latency = {};
	let ops = count('ycsb_keys');
	for (const type of OP_TYPES) {
		const values = data.metrics[`ycsb_${type}`]?.values;
		if (!values?.count) continue;
		ops += values.count;
		latency[type] = {
			count: values.count,
			min: values.min,
			max: values.max,
			mean: values.avg,
			p50: values['p(50)'],
			p95: values['p(95)'],
			p99: values['p(99)'],
			p999: values['p(99.9)'],
		};
	}
	const summary = {
		phaseId: phase.phaseId,
		iterations: count('iterations'),
		ops,
		errors: count('ycsb_errors'),
		latency,
	};
	return { stdout: `${SUMMARY_MARKER}${JSON.stringify(summary)}\n` };
}
