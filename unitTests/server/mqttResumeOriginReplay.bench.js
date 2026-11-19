/**
 * Benchmark: what a durable MQTT session's reconnect to the node that saved it costs when another origin's
 * history is replayed from its checkpoint boundary (harper#3790), on one wildcard QoS 1 topic that every session
 * subscribes to. In process, through the real sessions, table subscription and transaction logs; the other origin's
 * writes are applied as replication applies them.
 * Run via: npm run build && npx mocha unitTests/server/mqttResumeOriginReplay.bench.js
 * MQTT_RESUME_BENCH_SESSIONS (comma list), _WINDOW (comma list: the other origin's messages each session took
 * and acknowledged above that origin's boundary before it saved its position), _BACKLOG (its messages that arrive
 * below the position after the save), _OTHER (its writes to another table of the database in the same span, which
 * the replay reads and passes over).
 */
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS ??= String(24 * 60 * 60 * 1000);
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { persistOriginClosedFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor } = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const { transaction } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const list = (name, fallback) => (process.env[name] ?? fallback).split(',').map(Number);
const SESSION_COUNTS = list('MQTT_RESUME_BENCH_SESSIONS', '100,1000');
const WINDOWS = list('MQTT_RESUME_BENCH_WINDOW', '300,2000');
const BACKLOG = Number(process.env.MQTT_RESUME_BENCH_BACKLOG ?? 50);
const OTHER = Number(process.env.MQTT_RESUME_BENCH_OTHER ?? 20_000);
const SEQ = Symbol.for('seq');
const user = { username: 'mqtt-resume-bench', role: { permission: { super_user: true } } };

let sequence = 0;

function certify(T) {
	const rootStore = T.primaryStore.rootStore;
	if (typeof rootStore.syncWal !== 'function') rootStore.syncWal = () => Promise.resolve();
	let floor = certifyOriginFloor(rootStore);
	for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
	if (floor) {
		persistOriginClosedFloor(T.auditStore, floor);
		publishOriginFloor(rootStore, floor);
	}
}

function applyFromOrigin(T, nodeId, logKey, id) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await T.getResource(id, context);
		resource._writePublish(id, { value: id }, { isNotification: true, nodeId, version: logKey });
	});
}

async function connect(clientId, counter) {
	const session = await getSession({ clientId, user, clean: false });
	session.setListener((_topic, _message, messageId) => {
		counter.delivered++;
		// answered within the turn, as a prompt client would
		queueMicrotask(() => session.acknowledge(messageId));
		return true;
	});
	session.closeConnection = () => counter.closed++;
	return session;
}

async function run(sessionCount, window) {
	const name = `ResumeBench${++sequence}`;
	const database = `resume_bench_${name}`;
	const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'value' }];
	const T = table({ table: name, database, audit: true, attributes });
	const Other = table({ table: `${name}Other`, database, audit: true, attributes });
	Resources.resources.set(name, T, { mqtt: true });
	const topic = `${name}/#`;
	await T.put('seed', { value: 0 });
	const counter = { delivered: 0, closed: 0 };
	const clientIds = Array.from({ length: sessionCount }, (_, index) => `${name}-${index}`);
	let sessions = [];
	for (const clientId of clientIds) {
		const session = await connect(clientId, counter);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		sessions.push(session);
	}
	await sleep(5);
	const originFloor = Date.now();
	const originName = `peer-${name}`;
	const origin = getIdOfRemoteNode(originName, T.auditStore);
	T.dbisDB.putSync([SEQ, origin], {
		seqId: 1,
		nodes: [
			{
				id: origin,
				closedFloor: originFloor,
				originGeneration: 'peer-generation',
				fullCoverage: true,
				certifiedFrom: 0,
			},
		],
	});
	const checkpointed = async () => {
		await sleep(2);
		certify(T);
		await waitFor(() => {
			for (const session of sessions) session.checkpoint();
			return sessions.every((session) => session.topics.get(topic).entry.checkpoint !== undefined);
		}, 30_000);
	};
	await checkpointed();
	// every key the other origin writes in this run is within a millisecond-scale span above its floor
	let key = originFloor;
	const nextKey = () => (key += 0.001);
	for (let index = 0; index < window; index++) await applyFromOrigin(T, origin, nextKey(), `taken-${index}`);
	for (let index = 0; index < OTHER; index++) await applyFromOrigin(Other, origin, nextKey(), `other-${index}`);
	const lateKeys = Array.from({ length: BACKLOG }, nextKey);
	await waitFor(() => counter.delivered === sessionCount * window, 300_000);
	while (Date.now() <= key + 5) await sleep(5);
	await T.put('local', { value: 'local' });
	await waitFor(() => counter.delivered === sessionCount * (window + 1), 60_000);
	await checkpointed();
	for (const session of sessions) session.disconnect(true);
	await Promise.all(sessions.map((session) => session.writes));
	for (let index = 0; index < BACKLOG; index++) await applyFromOrigin(T, origin, lateKeys[index], `late-${index}`);

	counter.delivered = 0;
	const cpuBefore = process.cpuUsage();
	const startedAt = performance.now();
	let maxTurn = 0;
	let lastTurn = startedAt;
	const turns = setInterval(() => {
		const now = performance.now();
		if (now - lastTurn > maxTurn) maxTurn = now - lastTurn;
		lastTurn = now;
	}, 1);
	sessions = await Promise.all(clientIds.map((clientId) => connect(clientId, counter)));
	await Promise.all(sessions.map((session) => session.resume()));
	const verified = await Promise.all(sessions.map((session) => session.topics.get(topic).subscription.resumeVerified));
	// one more turn, so what the replays queued has been sent
	await sleep(50);
	clearInterval(turns);
	const elapsed = performance.now() - startedAt - 50;
	const cpu = process.cpuUsage(cpuBefore);
	const result = {
		'sessions': sessionCount,
		window,
		'backlog': BACKLOG,
		'other': OTHER,
		'resume ms': Math.round(elapsed),
		'cpu ms': Math.round((cpu.user + cpu.system) / 1000),
		'ms/session': +(elapsed / sessionCount).toFixed(2),
		'longest turn ms': Math.round(maxTurn),
		'delivered/session': +(counter.delivered / sessionCount).toFixed(1),
		'verified': verified.every(Boolean),
		'closed': counter.closed,
	};
	for (const session of sessions) session.disconnect(true);
	await Promise.all(sessions.map((session) => session.writes));
	Resources.resources.delete?.(name);
	return result;
}

describe('MQTT durable resume with another origin replayed from its boundary (benchmark)', function () {
	this.timeout(0);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		setOriginCaptureIntervalForTests(100);
	});
	it('measures reconnecting every session at once', async () => {
		const results = [];
		for (const sessionCount of SESSION_COUNTS) {
			for (const window of WINDOWS) results.push(await run(sessionCount, window));
		}
		console.table(results);
	});
});
