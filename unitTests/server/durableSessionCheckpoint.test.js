const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getDatabaseGeneration, persistOriginClosedFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { membersDigest, positionBefore } = require('#src/resources/subscriptionCheckpoint');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const { transaction } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const user = { username: 'mqtt-checkpoint-test', role: { permission: { super_user: true } } };

let sequence = 0;
function topicTable() {
	const name = `CheckpointTopic${++sequence}`;
	const T = table({
		table: name,
		database: `checkpoint_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return { T, name };
}

function certify(T) {
	const rootStore = T.primaryStore.rootStore;
	// a floor certifies only once synced; the pinned engine may predate syncWal, so the tick's sync is stood in for
	if (typeof rootStore.syncWal !== 'function') rootStore.syncWal = () => Promise.resolve();
	let floor = certifyOriginFloor(rootStore);
	for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
	if (floor) {
		persistOriginClosedFloor(T.auditStore, floor);
		publishOriginFloor(rootStore, floor);
	}
	return getOriginClosedFloor(rootStore)?.floor ?? 0;
}

async function connect(clientId) {
	const session = await getSession({ clientId, user, clean: false });
	const received = [];
	const closed = [];
	session.setListener((topic, message, messageId) => {
		received.push({ topic, message, messageId });
		return true;
	});
	session.closeConnection = (error) => closed.push(error ?? 'superseded');
	return { session, received, closed };
}

/** The newest scalar a kept checkpoint allows: just below its lowest boundary. */
function scalarCap(checkpoint) {
	return positionBefore(Math.min(checkpoint.time - checkpoint.overlap, ...Object.values(checkpoint.exceptions)));
}

const stored = (clientId) => databases.system.hdb_durable_session.get(clientId);
const values = (received) => received.map(({ message }) => message?.value);
const delivery = (received, value) => received.find(({ message }) => message?.value === value);

async function ackAll(session, received) {
	for (const { messageId } of received) session.acknowledge(messageId);
}

async function heldTransaction(T, ...ids) {
	let commit;
	const committed = transaction({}, async (context) => {
		for (const id of ids) await T.put(id, { value: id }, context);
		await new Promise((resolve) => (commit = resolve));
	});
	await waitFor(() => commit);
	return () => {
		commit();
		return committed;
	};
}

/**
 * Certifies a floor and waits until the saved entry carries a checkpoint at or past it. The session persists a
 * checkpoint at acknowledgements and on its timer (a tenth of the retention), so the timer is stood in for here.
 */
async function storedCheckpoint(T, session, clientId) {
	await sleep(2);
	const floor = certify(T);
	let entry;
	await waitFor(async () => {
		session.checkpoint();
		await session.writes;
		entry = (await stored(clientId))?.subscriptions?.[0];
		return entry?.checkpoint !== undefined && entry.checkpoint.time >= floor;
	}, 10_000);
	return entry.checkpoint;
}

describe('MQTT durable sessions with per-origin checkpoints (harper-pro#922)', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		setOriginCaptureIntervalForTests(100);
	});

	it('stores a checkpoint beside the scalar position and resumes from it after a reconnect', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `token-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		const checkpoint = await storedCheckpoint(T, first.session, clientId);
		assert.deepStrictEqual(checkpoint.exceptions, {});
		const entry = (await stored(clientId)).subscriptions[0];
		assert.ok(entry.startTime !== undefined, 'the scalar shadow is kept for an older reader');
		assert.strictEqual(entry.databaseGeneration, getDatabaseGeneration(T.auditStore).id);
		first.session.disconnect(true);
		await first.session.writes;
		await T.put('b', { value: 'b' });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('b'));
		assert.ok(!values(second.received).includes('a'), 'the acknowledged message is not redelivered');
		const state = second.session.topics.get(`${name}/#`);
		assert.strictEqual(state.subscription.ungated, true, 'resumed through the checkpoint');
		second.session.disconnect(true);
	});

	it('redelivers after a reconnect a transaction that committed below the checkpoint', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `late-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		const commitLate = await heldTransaction(T, 'late');
		await T.put('early', { value: 'early' });
		await waitFor(() => values(first.received).includes('early'));
		await ackAll(first.session, first.received);
		const checkpoint = await storedCheckpoint(T, first.session, clientId);
		first.session.disconnect(true);
		await first.session.writes;
		await commitLate();
		const lateKey = [...T.auditStore.getRange({ start: 1 })].find((entry) => entry.recordId === 'late').txnLogKey;
		assert.ok(checkpoint.time - checkpoint.overlap <= lateKey, 'the checkpoint waited for the open transaction');
		const second = await connect(clientId);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('late'));
		second.session.disconnect(true);
	});

	it('keeps the scalar position below the checkpoint, so a scalar fallback delivers an open transaction', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `scalar-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		const commitLate = await heldTransaction(T, 'late');
		await T.put('early', { value: 'early' });
		await waitFor(() => values(first.received).includes('early'));
		await ackAll(first.session, first.received);
		await storedCheckpoint(T, first.session, clientId);
		first.session.disconnect(true);
		await first.session.writes;
		const entry = (await stored(clientId)).subscriptions[0];
		assert.ok(entry.startTime <= scalarCap(entry.checkpoint), 'the scalar claims nothing the checkpoint does not');
		await commitLate();
		// an older reader, or a checkpoint refused as another scope, resumes from the scalar
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, checkpoint: { ...entry.checkpoint, scope: 'another' } }],
		});
		const second = await connect(clientId);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('late'));
		second.session.disconnect(true);
	});

	it('freezes the scalar at the kept checkpoint while none is certified', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `freeze-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		const checkpoint = await storedCheckpoint(T, first.session, clientId);
		const state = first.session.topics.get(topic);
		state.subscription.checkpoint = () => undefined;
		await T.put('b', { value: 'b' });
		await waitFor(() => values(first.received).includes('b'));
		await ackAll(first.session, first.received);
		first.session.checkpoint();
		await first.session.writes;
		assert.ok(state.entry.startTime <= scalarCap(checkpoint), 'the scalar stays at the kept checkpoint');
		first.session.disconnect(true);
	});

	it('holds an origin at an unacknowledged delivery, by origin', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `hold-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(received).includes('a'));
		await ackAll(session, received);
		await storedCheckpoint(T, session, clientId);
		await T.put('unacked', { value: 'unacked' });
		await waitFor(() => values(received).includes('unacked'));
		const state = session.topics.get(topic);
		const sent = state.unacked.get(delivery(received, 'unacked').messageId);
		assert.strictEqual(sent.origin, 0, 'the delivery names its origin');
		await sleep(2);
		certify(T);
		await sleep(400);
		session.checkpoint();
		await session.writes;
		const held = (await stored(clientId)).subscriptions[0].checkpoint;
		assert.ok(held.time <= sent.key, 'the boundary stays at the unacknowledged delivery');
		await session.acknowledge(delivery(received, 'unacked').messageId);
		const released = await storedCheckpoint(T, session, clientId);
		assert.ok(released.time > sent.key, 'the boundary passes the acknowledged delivery');
		session.disconnect(true);
	});

	it('QoS 2: keeps receipts bounded by the checkpoint floor, so a late lower-key delivery is new', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `qos2-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic, qos: 2, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(received).includes('a'));
		await session.received(delivery(received, 'a').messageId, false);
		await storedCheckpoint(T, session, clientId);
		const commitLate = await heldTransaction(T, 'late');
		await T.put('early', { value: 'early' });
		await waitFor(() => values(received).includes('early'));
		await session.received(delivery(received, 'early').messageId, false);
		const state = session.topics.get(topic);
		const earlyKey = state.unacked.get(delivery(received, 'early').messageId)?.key ?? state.deliveredKey;
		await sleep(2);
		certify(T);
		await sleep(400);
		session.checkpoint();
		await session.writes;
		assert.ok(
			state.receivedThrough === undefined || state.receivedThrough < earlyKey,
			'receipts are not compacted past the open transaction'
		);
		await commitLate();
		await waitFor(() => values(received).includes('late'));
		assert.ok(!delivery(received, 'late').dup, 'the late lower-key delivery is not suppressed');
		session.disconnect(true);
	});

	it('resets the session before CONNACK when the checkpoint certifies an origin this node lacks', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `foreign-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		const checkpoint = await storedCheckpoint(T, first.session, clientId);
		first.session.disconnect(true);
		await first.session.writes;
		const entry = (await stored(clientId)).subscriptions[0];
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, checkpoint: { ...checkpoint, members: membersDigest([['elsewhere', 'g']]) } }],
		});
		const second = await connect(clientId);
		assert.ok(!second.session.sessionWasPresent, 'a checkpoint this node cannot serve resets the session');
		assert.ok((await stored(clientId)) == null, 'the stale record is gone');
		second.session.disconnect(true);
	});

	it('falls back to the scalar position when the checkpoint names another scope', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `scope-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		const checkpoint = await storedCheckpoint(T, first.session, clientId);
		first.session.disconnect(true);
		await first.session.writes;
		const entry = (await stored(clientId)).subscriptions[0];
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, checkpoint: { ...checkpoint, scope: 'another' } }],
		});
		await T.put('missed', { value: 'missed' });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('missed'));
		second.session.disconnect(true);
	});
});
