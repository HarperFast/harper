'use strict';

// Per-call cost of recordAction: npx mocha unitTests/resources/analytics/recordAction.bench.js
// Each round is one fresh analytics window of CALLS calls, timed in this thread's CPU time; a round
// before the counted ones warms up. Generated paths and topics are new strings each round, with no
// cached hash, as a parsed topic or a new request path would be. The cases share recordAction's
// feedback, so for figures to compare, run each in its own process with --grep.
require('../../testUtils');
const { setupTestDBPath } = require('../../testUtils');
const {
	recordAction,
	recordActionBinary,
	setAnalyticsEnabled,
	checkAnalyticsEnabled,
} = require('#src/resources/analytics/write');

const CALLS = Number(process.env.RECORD_ACTION_BENCH_CALLS ?? 200_000);
const ROUNDS = Number(process.env.RECORD_ACTION_BENCH_ROUNDS ?? 9);
const HOT_PATHS = ['Topic', 'Device', 'Order', 'Customer', 'Product', 'Session', 'Event', 'Status'];

function threadCpuNs() {
	const { user, system } = process.threadCpuUsage?.() ?? process.cpuUsage();
	return (user + system) * 1000;
}

function freshPaths(count) {
	const paths = new Array(Math.ceil(count));
	for (let i = 0; i < paths.length; i++) paths[i] = '/r' + i;
	return paths;
}

// Decoded from bytes, as a parsed MQTT topic is, so each is a flat string with no cached hash
function freshTopics(count, name = (i) => `devices/${i}/telemetry`) {
	const topics = new Array(count);
	for (let i = 0; i < count; i++) topics[i] = Buffer.from(name(i)).toString('latin1');
	return topics;
}

function measure(prepare, run) {
	const perCall = [];
	for (let round = -1; round < ROUNDS; round++) {
		const input = prepare();
		setAnalyticsEnabled(true);
		global.gc?.();
		const start = threadCpuNs();
		run(input);
		const elapsed = threadCpuNs() - start;
		if (round >= 0) perCall.push(elapsed / CALLS);
	}
	perCall.sort((a, b) => a - b);
	const counter = process.threadCpuUsage ? 'thread' : 'process';
	return `median ${perCall[perCall.length >> 1].toFixed(1)} ns/call, min ${perCall[0].toFixed(1)} (${counter} CPU)`;
}

const cases = {
	'the same arguments every call': [
		() => {},
		() => {
			for (let i = 0; i < CALLS; i++) recordAction(1, 'bench-same', 'Topic', 'GET', 'mqtt');
		},
	],
	'recordActionBinary, the same arguments every call': [
		() => {},
		() => {
			for (let i = 0; i < CALLS; i++) recordActionBinary(true, 'bench-binary', 'Topic', 'GET');
		},
	],
	'the same topic every call, a new string each time': [
		() => freshTopics(CALLS, () => 'devices'),
		(topics) => {
			for (let i = 0; i < CALLS; i++) recordAction(1, 'bench-received', topics[i], 'publish', 'mqtt');
		},
	],
	'a status metric built every call': [
		() => 200,
		(status) => {
			for (let i = 0; i < CALLS; i++) recordActionBinary(1, 'response_' + status, 'Product', 'GET');
		},
	],
	'a distinct path every call': [
		() => freshPaths(CALLS),
		(paths) => {
			for (let i = 0; i < CALLS; i++) recordAction(1, 'bench-distinct', paths[i], 'GET');
		},
	],
	'a distinct topic every call, beside an indexed topic': [
		() => freshTopics(CALLS),
		(topics) => {
			recordAction(1, 'bench-beside', 'devices/hot/telemetry', 'puback', 'mqtt');
			recordAction(1, 'bench-beside', 'devices/hot/telemetry', 'puback', 'mqtt');
			for (let i = 0; i < CALLS; i++) recordAction(1, 'bench-beside', topics[i], 'puback', 'mqtt');
		},
	],
	'each topic twice, beside an indexed topic': [
		() => [freshTopics(Math.ceil(CALLS / 2)), freshTopics(Math.ceil(CALLS / 2))],
		([first, second]) => {
			recordAction(1, 'bench-twice', 'devices/hot/telemetry', 'puback', 'mqtt');
			recordAction(1, 'bench-twice', 'devices/hot/telemetry', 'puback', 'mqtt');
			for (let i = 0; i < CALLS; i++) {
				const topics = i < first.length ? first : second;
				recordAction(1, 'bench-twice', topics[i % first.length], 'puback', 'mqtt');
			}
		},
	],
	'8 hot paths, a new path every 100th call': [
		() => freshPaths(CALLS / 100),
		(paths) => {
			for (let i = 0; i < CALLS; i++)
				recordAction(1, 'bench-mix', i % 100 === 0 ? paths[i / 100] : HOT_PATHS[i & 7], 'GET');
		},
	],
};

describe('recordAction per-call cost', function () {
	let wasEnabled;

	before(() => {
		setupTestDBPath();
		wasEnabled = checkAnalyticsEnabled(false);
	});

	after(() => {
		setAnalyticsEnabled(wasEnabled);
	});

	for (const [name, [prepare, run]] of Object.entries(cases)) {
		it(name, () => {
			console.log(`      ${name}: ${measure(prepare, run)}`);
		});
	}
});
