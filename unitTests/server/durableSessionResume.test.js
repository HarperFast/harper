const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { raiseAuditFloor, getDatabaseGeneration } = require('#src/resources/auditStore');
const { transaction } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const user = { username: 'mqtt-durable-test', role: { permission: { super_user: true } } };

let sequence = 0;
function topicTable() {
	const name = `DurableTopic${++sequence}`;
	const T = table({
		table: name,
		database: `durable_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return { T, name };
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

const stored = (clientId) => databases.system.hdb_durable_session.get(clientId);
const values = (received) => received.map(({ message }) => message?.value);

async function ackAll(session, received) {
	for (const { messageId } of received) session.acknowledge(messageId);
}

/** Wait until the stored record's first entry satisfies `condition`. */
async function storedEntry(clientId, condition) {
	let entry;
	await waitFor(async () => {
		entry = (await stored(clientId))?.subscriptions?.[0];
		return entry && condition(entry);
	});
	return entry;
}

describe('MQTT durable sessions resuming through the checked subscription', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('binds a position once it is certified, and advances it as messages are acknowledged', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const { session, received } = await connect(`bind-${name}`);
		await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => received.length >= 1);
		await ackAll(session, received);
		const entry = await storedEntry(`bind-${name}`, (entry) => entry.databaseGeneration !== undefined);
		assert.strictEqual(entry.databaseGeneration, getDatabaseGeneration(T.auditStore).id);
		session.disconnect(true);
	});

	it('does not move past a transaction until every one of its messages is acknowledged', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `shared-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('before', { value: 'before' });
		await waitFor(() => received.length >= 1);
		await ackAll(session, received);
		const settled = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		await transaction({}, async (context) => {
			await T.put('x', { value: 'x' }, context);
			await T.put('y', { value: 'y' }, context);
		});
		await waitFor(() => received.length >= 3);
		session.acknowledge(received[1].messageId);
		session.checkpoint();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(
			(await stored(clientId)).subscriptions[0].startTime,
			settled.startTime,
			'half a transaction is not a boundary'
		);
		session.acknowledge(received[2].messageId);
		await storedEntry(clientId, (entry) => entry.startTime > settled.startTime);
		session.disconnect(true);
	});

	it('resumes a session after a reconnect, and delivers what it missed', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `resume-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		await T.put('b', { value: 2 });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await second.session.resume();
		await waitFor(() => values(second.received).includes(2));
		assert.ok(!values(second.received).includes(1), 'the acknowledged message is not redelivered');
		second.session.disconnect(true);
	});

	it('resets a wildcard session whose position fell below the floor, before CONNACK', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `pruned-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		await T.put('b', { value: 2 });
		raiseAuditFloor(T.auditStore, entry.startTime + 0.001);
		const second = await connect(clientId);
		assert.ok(!second.session.sessionWasPresent);
		assert.ok((await stored(clientId)) == null, 'the stale record is gone');
		second.session.disconnect(true);
	});

	it('discards the session when the checked replay is refused after CONNACK', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `refused-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true, 'precondition: the pre-check passed');
		// retention advances between CONNACK and the resume
		raiseAuditFloor(T.auditStore, entry.startTime + 0.001);
		await second.session.resume();
		await waitFor(() => second.closed.length === 1);
		assert.strictEqual(second.closed[0].code, 'RESUME_HISTORY_UNAVAILABLE');
		await waitFor(async () => (await stored(clientId)) == null);
		assert.deepStrictEqual(values(second.received), [], 'no short replay');
	});

	it('advances a quiet topic to the watermark when other tables write', async () => {
		const { T, name } = topicTable();
		const Other = table({
			table: `${name}Other`,
			database: `durable_${name}`,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		await T.put('seed', { value: 0 });
		const clientId = `quiet-${name}`;
		const { session } = await connect(clientId);
		await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		const checkpointed = async () => {
			session.checkpoint();
			await session.writes;
			return (await stored(clientId)).subscriptions[0];
		};
		await Other.put('noise', { value: 1 });
		let first;
		await waitFor(async () => (first = await checkpointed()).databaseGeneration !== undefined);
		await Other.put('noise', { value: 2 });
		await waitFor(async () => (await checkpointed()).startTime > first.startTime);
		session.disconnect(true);
	});

	it('keeps each topic its own position when another topic is added', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `positions-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => received.length >= 1);
		// unacknowledged: the position must stay before it however the record is rewritten
		const before = (await stored(clientId)).subscriptions[0].startTime;
		await session.addSubscription({ topic: `${name}/other`, qos: 1, rh: 2 }, true);
		const after = (await stored(clientId)).subscriptions.find((entry) => entry.topic === `${name}/#`);
		assert.strictEqual(after.startTime, before, 'harper#2908: a save rewrites no position from the delivery cursor');
		session.disconnect(true);
	});

	it('resumes a record topic across a floor raise while its history is intact', async () => {
		const { T, name } = topicTable();
		await T.put('A', { value: 0 });
		const clientId = `record-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/A`, qos: 1, rh: 2 }, true);
		await T.put('A', { value: 1 });
		await waitFor(() => values(first.received).includes(1));
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		await T.put('A', { value: 2 });
		// retention elsewhere in the database passes the position, but A's own versions since it remain
		raiseAuditFloor(T.auditStore, entry.startTime + 0.001);
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true, 'a record is checked by its own history');
		await second.session.resume();
		await waitFor(() => values(second.received).includes(2));
		assert.deepStrictEqual(second.closed, []);
		second.session.disconnect(true);
	});

	it('checkpoints nothing past a resumed position until its replay verifies', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `verdict-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		for (let i = 0; i < 250; i++) await T.put(`r${i}`, { value: i });
		const second = await connect(clientId);
		// the first delivery waits on the test, so the replay fills the queue and blocks until released
		let release;
		const held = new Promise((resolve) => (release = resolve));
		second.session.setListener((topic, message, messageId) => {
			second.received.push({ topic, message, messageId });
			if (second.received.length === 1) return held.then(() => true);
			setImmediate(() => second.session.acknowledge(messageId));
			return true;
		});
		await second.session.resume();
		const state = second.session.topics.get(`${name}/#`);
		await waitFor(() => second.received.length === 1);
		second.session.acknowledge(second.received[0].messageId);
		assert.strictEqual(state.verified, false, 'precondition: the replay is blocked behind the held delivery');
		second.session.checkpoint();
		await second.session.writes;
		assert.strictEqual((await stored(clientId)).subscriptions[0].startTime, entry.startTime);
		release();
		await waitFor(() => state.verified);
		await waitFor(() => values(second.received).includes(249));
		await storedEntry(clientId, (stored) => stored.startTime > entry.startTime);
		second.session.disconnect(true);
	});

	it('takes no idle progress at disconnect past an event still queued', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `queued-${name}`;
		const { session } = await connect(clientId);
		// a listener that never finishes sending: the next event stays queued behind it
		session.setListener(() => new Promise(() => {}));
		await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		const before = (await stored(clientId)).subscriptions[0];
		await T.put('a', { value: 'a' });
		await T.put('b', { value: 'b' });
		const state = session.topics.get(`${name}/#`);
		await waitFor(() => state.subscription.sentCount >= 2);
		session.disconnect(true);
		await session.writes;
		const after = (await stored(clientId)).subscriptions[0];
		assert.ok(!(after.startTime > state.unacked.values().next().value?.previousKey ?? before.startTime));
		assert.ok(!(after.startTime >= state.deliveredKey), 'the undelivered event is not passed');
	});

	it('resets a durable session when its table is reloaded, whose rows have no history', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `reload-${name}`;
		const { session, closed } = await connect(clientId);
		await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.writeReloadMarker();
		await waitFor(() => closed.length === 1);
		assert.strictEqual(closed[0].code, 'RESUME_HISTORY_UNAVAILABLE');
		await waitFor(async () => (await stored(clientId)) == null);
	});

	it('ignores a legacy acks list rather than filtering by key', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `legacy-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 'a' });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		await transaction({}, async (context) => {
			await T.put('x', { value: 'x' }, context);
			await T.put('y', { value: 'y' }, context);
		});
		const keys = [...T.auditStore.getRange({ start: entry.startTime, exclusiveStart: true })].map((e) => e.txnLogKey);
		// an older binary recorded an out-of-order ack by key alone, which would filter both x and y
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, acks: [keys[0]] }],
		});
		const second = await connect(clientId);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('x') && values(second.received).includes('y'));
		const rewritten = await stored(clientId);
		assert.strictEqual(rewritten.subscriptions[0].acks, undefined, 'dropped at the next write');
		second.session.disconnect(true);
	});

	it('stops writing when another connection takes the session over', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `takeover-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await first.session.persist();
		assert.deepStrictEqual(first.closed, ['superseded']);
		assert.strictEqual((await stored(clientId)).incarnation, second.session.incarnation);
		second.session.disconnect(true);
	});
});

describe('MQTT durable sessions on LMDB', function () {
	if (isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('resume unchecked, as before, since LMDB has no generation', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `lmdb-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		first.session.checkpoint();
		await first.session.writes;
		assert.strictEqual((await stored(clientId)).subscriptions[0].databaseGeneration, undefined);
		first.session.disconnect(true);
		await T.put('b', { value: 2 });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await second.session.resume();
		await waitFor(() => values(second.received).includes(2));
		second.session.disconnect(true);
	});
});
