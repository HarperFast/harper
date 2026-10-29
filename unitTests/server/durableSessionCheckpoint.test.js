const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getDatabaseGeneration, persistOriginClosedFloor, raiseAuditFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { membersDigest } = require('#src/resources/subscriptionCheckpoint');
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

/** The floor stays checkpoint-grade but stops advancing: the tick's sync never lands, so it publishes nothing newer. */
function freezeFloor(T) {
	const rootStore = T.primaryStore.rootStore;
	const own = Object.hasOwn(rootStore, 'syncWal') ? rootStore.syncWal : undefined;
	rootStore.syncWal = () => new Promise(() => {});
	return () => {
		if (own) rootStore.syncWal = own;
		else delete rootStore.syncWal;
	};
}

const logKeyOf = (T, id) => [...T.auditStore.getRange({ start: 1 })].find((entry) => entry.recordId === id).txnLogKey;

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

function checkpointFloor(checkpoint) {
	return Math.min(checkpoint.time - checkpoint.overlap, ...Object.values(checkpoint.exceptions));
}

function resumeRequests(session) {
	const requests = [];
	const resumeSubscription = session.resumeSubscription;
	session.resumeSubscription = function (request, ...rest) {
		requests.push(request);
		return resumeSubscription.call(this, request, ...rest);
	};
	return requests;
}

/** A record saved in another database generation: another node's, or this database's before a restore. */
const ANOTHER_GENERATION = 'another-generation';
async function fromAnotherGeneration(clientId) {
	const record = await stored(clientId);
	await databases.system.hdb_durable_session.put({
		id: clientId,
		subscriptions: record.subscriptions.map((entry) => ({ ...entry, databaseGeneration: ANOTHER_GENERATION })),
	});
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

	it('stores a checkpoint beside the scalar position, and resumes on this node from the scalar', async () => {
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
		first.session.disconnect(true);
		await first.session.writes;
		const entry = (await stored(clientId)).subscriptions[0];
		assert.strictEqual(entry.databaseGeneration, getDatabaseGeneration(T.auditStore).id);
		await T.put('b', { value: 'b' });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		const requests = resumeRequests(second.session);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('b'));
		assert.ok(!values(second.received).includes('a'), 'the acknowledged message is not redelivered');
		assert.strictEqual(requests[0].resume, undefined, 'resumed from the scalar its own generation bound');
		assert.strictEqual(requests[0].startTime, entry.startTime);
		second.session.disconnect(true);
	});

	it('resumes from the checkpoint a session saved in another generation, delivering a commit below its scalar', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `late-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		await storedCheckpoint(T, first.session, clientId);
		const commitLate = await heldTransaction(T, 'late');
		await T.put('early', { value: 'early' });
		await waitFor(() => values(first.received).includes('early'));
		await ackAll(first.session, first.received);
		const checkpoint = await storedCheckpoint(T, first.session, clientId);
		first.session.disconnect(true);
		await first.session.writes;
		await commitLate();
		const lateKey = logKeyOf(T, 'late');
		assert.ok(checkpointFloor(checkpoint) <= lateKey, 'the checkpoint waited for the open transaction');
		const entry = (await stored(clientId)).subscriptions[0];
		await fromAnotherGeneration(clientId);
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		const requests = resumeRequests(second.session);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('late'));
		await T.put('after', { value: 'after' });
		await waitFor(() => values(second.received).includes('after'));
		assert.deepStrictEqual(requests[0].resume, entry.checkpoint, 'resumed from the checkpoint');
		assert.ok(!values(second.received).includes('a'), 'nothing below the checkpoint is sent again');
		assert.ok(entry.startTime > lateKey, 'the scalar is above the late commit, so only the checkpoint delivers it');
		second.session.disconnect(true);
	});

	it('keeps resuming from the checkpoint of another generation until this node moves the scalar', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `twice-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		await storedCheckpoint(T, first.session, clientId);
		first.session.disconnect(true);
		await first.session.writes;
		await fromAnotherGeneration(clientId);
		const { checkpoint } = (await stored(clientId)).subscriptions[0];
		// connecting rewrites the record before CONNACK; this connection ends before it moves the scalar
		const second = await connect(clientId);
		second.session.disconnect(true);
		await second.session.writes;
		assert.strictEqual((await stored(clientId)).subscriptions[0].databaseGeneration, ANOTHER_GENERATION);
		const third = await connect(clientId);
		const requests = resumeRequests(third.session);
		await third.session.resume();
		assert.deepStrictEqual(requests[0].resume, checkpoint, 'still resumed from the checkpoint');
		third.session.disconnect(true);
	});

	it('beside a checkpoint, keeps only the QoS 1 receipts above the scalar', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `receipts-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => values(first.received).includes('a'));
		await ackAll(first.session, first.received);
		await storedCheckpoint(T, first.session, clientId);
		const thaw = freezeFloor(T);
		try {
			for (let i = 0; i < 50; i++) {
				await T.put(`n${i}`, { value: i });
				await waitFor(() => values(first.received).includes(i));
				await first.session.acknowledge(delivery(first.received, i).messageId);
			}
			const inOrder = (await stored(clientId)).subscriptions[0];
			assert.strictEqual(inOrder.receivedRuns, undefined, 'the acknowledged deliveries the scalar passed are not kept');
			await transaction({}, async (context) => {
				await T.put('x', { value: 'x' }, context);
				await T.put('y', { value: 'y' }, context);
			});
			await waitFor(() => values(first.received).includes('y'));
			await first.session.acknowledge(delivery(first.received, 'y').messageId);
			first.session.disconnect(true);
			await first.session.writes;
			assert.ok((await stored(clientId)).subscriptions[0].received?.length > 0, 'the one held behind x is kept');
			const second = await connect(clientId);
			await second.session.resume();
			await T.put('after', { value: 'after' });
			await waitFor(() => values(second.received).includes('after'));
			assert.deepStrictEqual(values(second.received), ['x', 'after'], 'the acknowledged half is not sent again');
			second.session.disconnect(true);
		} finally {
			thaw();
		}
	});

	it('keeps the scalar at what the session reached while the checkpoint holds below an open transaction', async () => {
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
		await commitLate();
		assert.ok(
			checkpointFloor(entry.checkpoint) <= logKeyOf(T, 'late'),
			'the checkpoint holds below the open transaction'
		);
		assert.ok(entry.startTime >= logKeyOf(T, 'early'), 'the scalar is not held under the checkpoint');
		const second = await connect(clientId);
		await second.session.resume();
		await T.put('after', { value: 'after' });
		await waitFor(() => values(second.received).includes('after'));
		assert.ok(!values(second.received).includes('early'), 'the acknowledged delivery is not sent again');
		second.session.disconnect(true);
	});

	it('keeps its last checkpoint while none is certified, and the scalar keeps advancing', async () => {
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
		const entry = (await stored(clientId)).subscriptions[0];
		assert.deepStrictEqual(entry.checkpoint, checkpoint, 'the kept checkpoint is saved');
		assert.ok(entry.startTime >= logKeyOf(T, 'b'), 'the scalar passes the kept checkpoint');
		first.session.disconnect(true);
	});

	it("leaves a record topic to its own history walk on this node, not to its checkpoint's retention", async () => {
		const { T, name } = topicTable();
		await T.put('r', { value: 0 });
		const topic = `${name}/r`;
		const clientId = `record-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('r', { value: 1 });
		await waitFor(() => values(first.received).includes(1));
		await ackAll(first.session, first.received);
		await storedCheckpoint(T, first.session, clientId);
		const thaw = freezeFloor(T);
		try {
			await T.put('r', { value: 2 });
			await waitFor(() => values(first.received).includes(2));
			await first.session.acknowledge(delivery(first.received, 2).messageId);
			first.session.disconnect(true);
			await first.session.writes;
			const entry = (await stored(clientId)).subscriptions[0];
			// retention passes the checkpoint's boundary, below the record's newer versions
			raiseAuditFloor(T.auditStore, checkpointFloor(entry.checkpoint) + 0.001);
			await T.put('r', { value: 3 });
			const second = await connect(clientId);
			assert.strictEqual(second.session.sessionWasPresent, true, "the record's own versions show nothing was lost");
			await second.session.resume();
			await waitFor(() => values(second.received).includes(3));
			assert.deepStrictEqual(values(second.received), [3]);
			second.session.disconnect(true);
		} finally {
			thaw();
		}
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

	it('does not re-send an acknowledged delivery that the checkpoint has not caught up with', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `lagging-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a0', { value: 'a0' });
		await waitFor(() => values(first.received).includes('a0'));
		await ackAll(first.session, first.received);
		await storedCheckpoint(T, first.session, clientId);
		const thaw = freezeFloor(T);
		try {
			await T.put('a', { value: 'a' });
			await waitFor(() => values(first.received).includes('a'));
			await first.session.acknowledge(delivery(first.received, 'a').messageId);
			await first.session.writes;
			const acked = logKeyOf(T, 'a');
			const lagging = (await stored(clientId)).subscriptions[0];
			assert.ok(
				lagging.checkpoint.time - lagging.checkpoint.overlap < acked,
				'the saved checkpoint is below the acknowledged delivery'
			);
			first.session.disconnect(true);
			await first.session.writes;
			const saved = (await stored(clientId)).subscriptions[0];
			await T.put('b', { value: 'b' });
			const second = await connect(clientId);
			await second.session.resume();
			await waitFor(() => values(second.received).includes('b'));
			second.session.disconnect(true);
			assert.deepStrictEqual(values(second.received), ['b'], 'only the update made while away is delivered');
			assert.ok(saved.startTime >= acked, 'the saved position covers the acknowledged delivery');
		} finally {
			thaw();
		}
	});

	it('does not replay history from before the SUBSCRIBE when the first checkpoint is older than the topic', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		await sleep(2);
		certify(T);
		const thaw = freezeFloor(T);
		try {
			await T.put('before', { value: 'before' });
			const clientId = `fresh-${name}`;
			const first = await connect(clientId);
			await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
			await T.put('a', { value: 'a' });
			await waitFor(() => values(first.received).includes('a'));
			await ackAll(first.session, first.received);
			await waitFor(async () => {
				first.session.checkpoint();
				await first.session.writes;
				return (await stored(clientId))?.subscriptions?.[0]?.checkpoint !== undefined;
			}, 10_000);
			assert.deepStrictEqual(values(first.received), ['a']);
			first.session.disconnect(true);
			await first.session.writes;
			await T.put('b', { value: 'b' });
			const second = await connect(clientId);
			await second.session.resume();
			await waitFor(() => values(second.received).includes('b'));
			assert.deepStrictEqual(values(second.received), ['b'], 'nothing from before the SUBSCRIBE is delivered');
			second.session.disconnect(true);
		} finally {
			thaw();
		}
	});

	it('resumes on this node from the start of a topic whose first delivery is still unacknowledged', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		await sleep(2);
		certify(T);
		const thaw = freezeFloor(T);
		try {
			await T.put('before', { value: 'before' });
			const clientId = `unacked-${name}`;
			const first = await connect(clientId);
			await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
			await T.put('a', { value: 'a' });
			await waitFor(() => values(first.received).includes('a'));
			await waitFor(async () => {
				first.session.checkpoint();
				await first.session.writes;
				return (await stored(clientId))?.subscriptions?.[0]?.checkpoint !== undefined;
			}, 10_000);
			first.session.disconnect(true);
			await first.session.writes;
			await T.put('b', { value: 'b' });
			const second = await connect(clientId);
			await second.session.resume();
			await waitFor(() => values(second.received).includes('b'));
			assert.deepStrictEqual(values(second.received), ['a', 'b'], 'the unacknowledged delivery, and nothing before it');
			second.session.disconnect(true);
		} finally {
			thaw();
		}
	});

	it('checks before CONNACK only the checkpoint a session resumes from, resetting one this node cannot serve', async () => {
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
		const unservable = { ...checkpoint, members: membersDigest([['elsewhere', 'g']]) };
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, checkpoint: unservable }],
		});
		const kept = await connect(clientId);
		assert.strictEqual(kept.session.sessionWasPresent, true, 'this generation resumes from its scalar');
		kept.session.disconnect(true);
		await kept.session.writes;
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, databaseGeneration: ANOTHER_GENERATION, checkpoint: unservable }],
		});
		const second = await connect(clientId);
		assert.ok(!second.session.sessionWasPresent, 'a checkpoint this node cannot serve resets the session');
		assert.ok((await stored(clientId)) == null, 'the stale record is gone');
		second.session.disconnect(true);
	});

	it('falls back to the scalar position when the checkpoint it resumes from names another scope', async () => {
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
			subscriptions: [
				{ ...entry, databaseGeneration: ANOTHER_GENERATION, checkpoint: { ...checkpoint, scope: 'another' } },
			],
		});
		await T.put('missed', { value: 'missed' });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		const requests = resumeRequests(second.session);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('missed'));
		assert.ok(requests[0].resume !== undefined && requests[1].resume === undefined, 'refused, then the scalar');
		second.session.disconnect(true);
	});
});
