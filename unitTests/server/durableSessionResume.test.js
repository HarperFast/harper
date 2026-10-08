const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { Resource } = require('#src/resources/Resource');
const { raiseAuditFloor, getDatabaseGeneration } = require('#src/resources/auditStore');
const { transaction } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { handleApplication, setTakeoverTimeoutForTests } = require('#src/server/mqtt');
const { generate } = require('mqtt-packet');
const { EventEmitter } = require('node:events');
const mqttPacket = require('mqtt-packet');
const { DatabaseGenerationChangedError, ResumeHistoryUnavailableError } = require('#src/utility/errors/hdbError');
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

class Unavailable extends Resource {
	static subscribe() {
		return Promise.reject(new Error('temporarily unavailable'));
	}
}

function mqttListener() {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	const open = () => {
		const socket = { closes: [], sends: [], handlers: {}, _socket: { remoteAddress: '127.0.0.1' } };
		socket.close = () => socket.closes.push(true);
		socket.terminate = () => (socket.terminated = true);
		socket.send = (message) => socket.sends.push(message);
		socket.on = (event, handler) => (socket.handlers[event] = handler);
		const headers = { 'sec-websocket-protocol': 'mqtt' };
		const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
		listener(socket, request, Promise.resolve({ status: 200 }), () => {});
		return socket;
	};
	open.sessions = server.mqtt.sessions;
	return open;
}

const connectPacket = (clientId, properties = {}) =>
	generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId, clean: false, ...properties });

function holdSaves(holds = () => true) {
	const sessions = databases.system.hdb_durable_session;
	const put = sessions.put;
	const held = [];
	sessions.put = function (...args) {
		if (!holds(args[0])) return put.apply(this, args);
		return new Promise((resolve, reject) => held.push(() => put.apply(this, args).then(resolve, reject)));
	};
	return {
		held,
		release() {
			sessions.put = put;
			for (const write of held.splice(0)) write();
		},
	};
}

function sentPackets(socket) {
	const parser = mqttPacket.parser({ protocolVersion: 5 });
	const packets = [];
	parser.on('packet', (packet) => packets.push(packet));
	for (const sent of socket.sends) parser.parse(sent);
	return packets;
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

/** Opens a transaction that takes its log key with its writes, and commits it when the returned function is called. */
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

const delivery = (received, value) => received.find(({ message }) => message?.value === value);

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

	it('settles an acknowledgement once the position it allows is saved', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `ack-saved-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => received.length >= 1);
		const state = session.topics.get(topic);
		await waitFor(() => state.subscription.progress() >= state.deliveredKey);
		await session.acknowledge(received[0].messageId);
		const saved = (await stored(clientId)).subscriptions[0];
		assert.ok(saved.startTime >= state.deliveredKey, 'the acknowledged delivery is saved by then');
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

	it('keeps a delivered transaction that committed after a higher key until it is acknowledged', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `late-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const commitLate = await heldTransaction(T, 'late');
		await T.put('early', { value: 'early' });
		await waitFor(() => values(first.received).includes('early'));
		await commitLate();
		await waitFor(() => values(first.received).includes('late'));
		const state = first.session.topics.get(topic);
		const key = (value) => state.unacked.get(delivery(first.received, value).messageId).key;
		const lateKey = key('late');
		assert.ok(lateKey < key('early'), 'the late transaction holds the lower key');
		await waitFor(() => state.subscription.progress() > lateKey);
		await first.session.acknowledge(delivery(first.received, 'early').messageId);
		assert.ok((await stored(clientId)).subscriptions[0].startTime < lateKey, 'the unacknowledged delivery is kept');
		first.session.disconnect(true);
		await first.session.writes;
		const second = await connect(clientId);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('late'));
		second.session.disconnect(true);
	});

	it('keeps a delivery whose key is below the bound of an older unacknowledged one', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `below-older-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const commitA = await heldTransaction(T, 'a');
		const commitC = await heldTransaction(T, 'c');
		await T.put('b', { value: 'b' });
		await T.put('e', { value: 'e' });
		await waitFor(() => values(received).includes('e'));
		await commitA();
		await waitFor(() => values(received).includes('a'));
		await commitC();
		await waitFor(() => values(received).includes('c'));
		assert.deepStrictEqual(values(received), ['b', 'e', 'a', 'c']);
		const state = session.topics.get(topic);
		const key = (value) => state.unacked.get(delivery(received, value).messageId).key;
		const cKey = key('c');
		assert.ok(key('a') < cKey && cKey < key('b'), 'c commits below b and e, after a');
		await waitFor(() => state.subscription.progress() > cKey);
		session.acknowledge(delivery(received, 'b').messageId);
		await session.acknowledge(delivery(received, 'a').messageId);
		assert.ok(
			(await stored(clientId)).subscriptions[0].startTime < cKey,
			'e, the oldest unacknowledged, does not bound c'
		);
		session.disconnect(true);
	});

	it('keeps the queued rest of a transaction that committed after a higher key, whatever else awaits an acknowledgement', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `late-queued-${name}`;
		const { session } = await connect(clientId);
		const delivered = [];
		// acknowledges all but one message as it is sent, and never finishes sending the late transaction's first
		session.setListener((_topic, message, messageId) => {
			delivered.push(message?.value);
			if (message?.value !== 'unacked') session.acknowledge(messageId);
			return message?.value === 'late' ? new Promise(() => {}) : true;
		});
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const commitLate = await heldTransaction(T, 'late', 'late-rest');
		await T.put('early', { value: 'early' });
		await T.put('unacked', { value: 'unacked' });
		await waitFor(() => delivered.includes('unacked'));
		await commitLate();
		const state = session.topics.get(topic);
		await waitFor(() => state.subscription.sentCount >= 4);
		assert.deepStrictEqual(delivered, ['early', 'unacked', 'late']);
		const lateKey = state.deliveredKey;
		session.disconnect(true);
		await session.writes;
		assert.ok((await stored(clientId)).subscriptions[0].startTime < lateKey, 'the queued rest shares the late key');
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

	it('resumes a session whose positions name another generation from where they are, and binds them here', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `other-generation-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		await first.session.writes;
		await T.put('missed', { value: 'missed' });
		// another node's generation, or this database's before a restore or copy
		const otherGeneration = 'f'.repeat(entry.databaseGeneration.length);
		await databases.system.hdb_durable_session.put({
			id: clientId,
			subscriptions: [{ ...entry, databaseGeneration: otherGeneration }],
		});
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true, 'another generation resumes rather than resets');
		await second.session.resume();
		await waitFor(() => values(second.received).includes('missed'));
		// a live write gives the session a certified position to bind
		await T.put('later', { value: 'later' });
		await waitFor(() => values(second.received).includes('later'));
		await ackAll(second.session, second.received);
		const current = getDatabaseGeneration(T.auditStore).id;
		await storedEntry(clientId, (saved) => saved.databaseGeneration === current);
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
		assert.ok(!(after.startTime >= state.deliveredKey), 'the undelivered event is not passed');
		assert.ok(after.startTime <= Math.max(before.startTime, state.keyBefore ?? before.startTime));
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

	it('freezes, and never binds, a topic whose certificate is unavailable', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `frozen-${name}`;
		// a range that already recorded a failed read certifies nothing from the start
		const attach = await T.subscribe({ omitCurrent: true });
		T.auditStore.subscriptionLogRange.failedLogs.add('unreadable');
		const { session, received } = await connect(clientId);
		try {
			await session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
			const before = (await stored(clientId)).subscriptions[0];
			await T.put('a', { value: 1 });
			await T.put('b', { value: 2 });
			await waitFor(() => received.length >= 2);
			await ackAll(session, received);
			session.checkpoint();
			await session.writes;
			const after = (await stored(clientId)).subscriptions[0];
			assert.strictEqual(after.startTime, before.startTime, 'no certificate, no progress');
			assert.strictEqual(after.databaseGeneration, undefined);
		} finally {
			T.auditStore.subscriptionLogRange.failedLogs.delete('unreadable');
			attach.end();
			session.disconnect(true);
		}
	});

	it('rolls back a SUBSCRIBE whose record could not be saved, whatever its QoS', async () => {
		for (const qos of [1, 0]) {
			const { T, name } = topicTable();
			await T.put('seed', { value: 0 });
			const clientId = `unsaved-${qos}-${name}`;
			const { session, received } = await connect(clientId);
			const sessions = databases.system.hdb_durable_session;
			const put = sessions.put;
			sessions.put = function () {
				sessions.put = put;
				return Promise.reject(new Error('system table unavailable'));
			};
			try {
				await assert.rejects(session.addSubscription({ topic: `${name}/#`, qos, rh: 2 }, qos > 0), /unavailable/);
			} finally {
				sessions.put = put;
			}
			assert.strictEqual(session.topics.size, 0, `QoS ${qos}`);
			assert.strictEqual(session.subscriptions.length, 0, `QoS ${qos}`);
			await T.put('a', { value: 1 });
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepStrictEqual(received, [], `the refused QoS ${qos} subscription delivers nothing`);
			session.disconnect(true);
		}
	});

	it('starts no checkpoint timer for a SUBSCRIBE that finishes after the session disconnected', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const { session } = await connect(`late-subscribe-${name}`);
		const subscribing = session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		session.disconnect(true);
		await subscribing;
		assert.strictEqual(session.checkpointTimer, undefined);
	});

	it('reports an UNSUBSCRIBE whose save failed as failed again on a retry, until the removal is saved', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `unsubscribe-retry-${name}`;
		const { session } = await connect(clientId);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const sessions = databases.system.hdb_durable_session;
		const put = sessions.put;
		sessions.put = () => Promise.reject(new Error('system table unavailable'));
		try {
			await assert.rejects(session.removeSubscription(topic), /unavailable/);
			await assert.rejects(session.removeSubscription(topic), /unavailable/);
			let failHeld;
			sessions.put = () =>
				new Promise((_resolve, reject) => (failHeld = () => reject(new Error('system table unavailable'))));
			session.checkpoint();
			await waitFor(() => failHeld);
			const retry = session.removeSubscription(topic);
			await new Promise(setImmediate);
			failHeld();
			await assert.rejects(retry, /unavailable/, 'a retry waits for the save already in flight');
		} finally {
			sessions.put = put;
		}
		assert.ok(!(await session.removeSubscription(topic)), 'no subscription is left to remove');
		assert.deepStrictEqual((await stored(clientId)).subscriptions, [], 'the removal is saved');
		session.disconnect(true);
	});

	it('leaves a newer SUBSCRIBE to the topic in place when an older one fails', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const { session, received } = await connect(`overlap-${name}`);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const older = session.subscriptions[0];
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const newer = session.subscriptions[0];
		assert.notStrictEqual(newer, older);
		session.dropFailedSubscription(topic, older, undefined);
		assert.deepStrictEqual(session.subscriptions, [newer]);
		assert.strictEqual(session.topics.get(topic).subscription, newer);
		await T.put('a', { value: 1 });
		await waitFor(() => values(received).includes(1));
		session.disconnect(true);
	});

	it('applies overlapping SUBSCRIBEs to one topic in order, leaving one subscription', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const { session, received } = await connect(`in-order-${name}`);
		await Promise.all([
			session.addSubscription({ topic, qos: 1, rh: 2 }, true),
			session.addSubscription({ topic, qos: 1, rh: 2 }, true),
		]);
		assert.strictEqual(session.subscriptions.length, 1);
		assert.strictEqual(session.topics.get(topic).subscription, session.subscriptions[0]);
		await T.put('a', { value: 1 });
		await waitFor(() => values(received).includes(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepStrictEqual(values(received), [1], 'one subscription delivers once');
		session.disconnect(true);
	});

	it('continues a durable topic from its position when the client subscribes to it again', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `resubscribe-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		await first.session.writes;
		const saved = (await stored(clientId)).subscriptions[0];
		await T.put('missed', { value: 'missed' });
		const second = await connect(clientId);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('missed'));
		// a live write moves the watermark past the delivery the client has not acknowledged
		await T.put('later', { value: 'later' });
		await waitFor(() => values(second.received).includes('later'));
		await second.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const resubscribed = (await stored(clientId)).subscriptions[0];
		assert.strictEqual(resubscribed.startTime, saved.startTime, 'the unacknowledged delivery still holds the position');
		assert.strictEqual(resubscribed.databaseGeneration, saved.databaseGeneration);
		await waitFor(() => values(second.received).filter((value) => value === 'missed').length === 2);
		second.session.disconnect(true);
	});

	it('drops a durable topic whose replacing SUBSCRIBE fails', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `replaced-${name}`;
		const { session } = await connect(clientId);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await storedEntry(clientId, () => true);
		Resources.resources.set(name, Unavailable, { mqtt: true }, true);
		await assert.rejects(session.addSubscription({ topic, qos: 1, rh: 2 }, true), /temporarily unavailable/);
		assert.strictEqual(session.topics.size, 0);
		assert.strictEqual(session.subscriptions.length, 0);
		await waitFor(async () => (await stored(clientId)).subscriptions.length === 0);
		session.disconnect(true);
	});

	it('keeps a QoS 0 subscription with the session, resuming it live', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = `${name}/#`;
		const clientId = `qos0-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 0, rh: 2 }, false);
		const entry = await storedEntry(clientId, () => true);
		assert.deepStrictEqual({ ...entry }, { qos: 0, topic });
		first.session.disconnect(true);
		const dispatched = [];
		const observer = await T.subscribe({ omitCurrent: true, listener: (event) => dispatched.push(event.value?.value) });
		await T.put('away', { value: 'away' });
		// a live subscription registered before the write is dispatched would still receive it
		await waitFor(() => dispatched.includes('away'));
		observer.end();
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await second.session.resume();
		await T.put('back', { value: 'back' });
		await waitFor(() => values(second.received).includes('back'));
		assert.deepStrictEqual(values(second.received), ['back'], 'QoS 0 replays nothing from while it was away');
		assert.strictEqual(second.session.awaitingAcks?.size ?? 0, 0, 'QoS 0 deliveries await no acknowledgement');
		second.session.disconnect(true);
	});

	it('keeps an uncertified topic before a key a queued message may share', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		class Uncertified extends Resource {
			static async subscribe(request) {
				const inner = await T.subscribe({ startTime: request.startTime, omitCurrent: true });
				return { [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](), end: () => inner.end() };
			}
		}
		Resources.resources.set(`${name}Wrapped`, Uncertified, { mqtt: true });
		const topic = `${name}Wrapped/#`;
		const clientId = `uncertified-${name}`;
		const first = await connect(clientId);
		first.session.setListener((_topic, message, messageId) => {
			first.received.push({ message, messageId });
			if (message?.value === 'x') first.session.acknowledge(messageId);
			return true;
		});
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const subscribed = await storedEntry(clientId, () => true);
		await transaction({}, async (context) => {
			await T.put('x', { value: 'x' }, context);
			await T.put('y', { value: 'y' }, context);
		});
		await waitFor(() => values(first.received).includes('y'));
		await first.session.writes;
		const saved = (await stored(clientId)).subscriptions[0];
		assert.strictEqual(saved.startTime, subscribed.startTime, 'acking x cannot pass y, which shares its key');
		first.session.disconnect(true);
		const second = await connect(clientId);
		await second.session.resume();
		await waitFor(() => values(second.received).includes('y'));
		second.session.disconnect(true);
	});

	it('closes the connection, keeping the session, when a resume fails for another reason', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `resume-error-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await T.put('a', { value: 1 });
		await waitFor(() => first.received.length >= 1);
		await ackAll(first.session, first.received);
		const entry = await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined);
		first.session.disconnect(true);
		Resources.resources.set(name, Unavailable, { mqtt: true }, true);
		const second = await connect(clientId);
		await second.session.resume();
		assert.strictEqual(second.closed.length, 1);
		assert.match(second.closed[0].message, /temporarily unavailable/);
		const kept = (await stored(clientId)).subscriptions[0];
		assert.strictEqual(kept.startTime, entry.startTime, 'the session is kept for the next connect');
	});

	it('takes the session over when two CONNECTs for one client id arrive together', async () => {
		const open = mqttListener();
		const sockets = [open(), open()];
		const packet = generate({
			cmd: 'connect',
			protocolId: 'MQTT',
			protocolVersion: 5,
			clientId: `together-${++sequence}`,
			clean: false,
		});
		// both packets are parsed before either connection has registered its session
		for (const socket of sockets) socket.handlers.message(packet);
		await waitFor(() => sockets.every((socket) => socket.sends.length > 0) && sockets[0].closes.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepStrictEqual(
			sockets.map((socket) => socket.closes.length),
			[1, 0],
			'the later CONNECT takes over'
		);
		sockets[1].handlers.close();
	});

	it('describes a resume refusal in its DISCONNECT, but not another failure', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const clientId = `disconnect-${name}`;
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await storedEntry(clientId, () => true);
		first.session.disconnect(true);
		await first.session.writes;
		const open = mqttListener();
		const reasons = [];
		// the session survives a failure that is not a refusal and a new generation, and is discarded by pruned history
		for (const failure of [
			Object.assign(new Error('an internal detail'), { statusCode: 409 }),
			new DatabaseGenerationChangedError(),
			new ResumeHistoryUnavailableError(),
		]) {
			class Failing extends Resource {
				static subscribe() {
					return Promise.reject(failure);
				}
			}
			Resources.resources.set(name, Failing, { mqtt: true }, true);
			const socket = open();
			socket.handlers.message(
				generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 5, clientId, clean: false })
			);
			await waitFor(() => socket.closes.length > 0);
			const disconnect = sentPackets(socket).find((packet) => packet.cmd === 'disconnect');
			assert.strictEqual(disconnect?.reasonCode, 0x83);
			reasons.push(disconnect.properties?.reasonString);
			socket.handlers.close();
		}
		assert.deepStrictEqual(reasons, [
			undefined,
			new DatabaseGenerationChangedError().message,
			new ResumeHistoryUnavailableError().message,
		]);
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

	it('saves what an older connection had acknowledged before a takeover reads the session', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const topic = `${name}/#`;
		const clientId = `yield-${name}`;
		const older = open();
		older.handlers.message(
			Buffer.concat([
				connectPacket(clientId),
				generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 1, rh: 2 }] }, { protocolVersion: 5 }),
			])
		);
		await waitFor(() => sentPackets(older).some((packet) => packet.cmd === 'suback'));
		const olderSession = [...open.sessions].find((session) => session.sessionId === clientId);
		await T.put('a', { value: 1 });
		const delivered = await waitFor(() => sentPackets(older).find((packet) => packet.cmd === 'publish'));
		const state = olderSession.topics.get(topic);
		await waitFor(
			() => state.subscription.progress() >= state.deliveredKey && state.consumed === state.subscription.sentCount
		);
		// the PUBACK's checkpoint waits for a later turn, and the takeover arrives first
		older.handlers.message(generate({ cmd: 'puback', messageId: delivered.messageId }, { protocolVersion: 5 }));
		const newer = open();
		newer.handlers.message(connectPacket(clientId));
		await waitFor(() => sentPackets(newer).some((packet) => packet.cmd === 'connack'));
		const saved = (await stored(clientId)).subscriptions[0];
		assert.ok(saved.startTime >= state.deliveredKey, 'the acknowledged delivery is not sent again');
		older.handlers.close();
		newer.handlers.close();
	});

	it('lets no SUBSCRIBE still in flight on a taken-over connection write the session again', async () => {
		const { name } = topicTable();
		let releaseSubscribe;
		class Slow extends Resource {
			static subscribe() {
				return new Promise((resolve) => (releaseSubscribe = () => resolve(undefined)));
			}
		}
		Resources.resources.set(name, Slow, { mqtt: true }, true);
		const open = mqttListener();
		const clientId = `late-subscribe-${name}`;
		const older = open();
		older.handlers.message(connectPacket(clientId));
		await waitFor(() => older.sends.length > 0);
		older.handlers.message(
			generate(
				{ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: `${name}/#`, qos: 1 }] },
				{ protocolVersion: 5 }
			)
		);
		await waitFor(() => releaseSubscribe);
		const newer = open();
		newer.handlers.message(connectPacket(clientId));
		await waitFor(() => newer.sends.length > 0);
		releaseSubscribe();
		await waitFor(() => sentPackets(older).some((packet) => packet.cmd === 'suback'));
		const newerSession = [...open.sessions].find((session) => session.sessionId === clientId && !session.terminated);
		await newerSession.persist();
		assert.deepStrictEqual(newer.closes, [], 'the older connection did not take the session back');
		assert.strictEqual((await stored(clientId)).incarnation, newerSession.incarnation);
		older.handlers.close();
		newer.handlers.close();
	});

	it('answers packets sent right behind a CONNECT, a takeover included', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `pipelined-${name}`;
		const sockets = [];
		for (let i = 0; i < 2; i++) {
			const socket = open();
			sockets.push(socket);
			socket.handlers.message(
				Buffer.concat([
					connectPacket(clientId),
					generate(
						{ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: `${name}/#`, qos: 1, rh: 2 }] },
						{ protocolVersion: 5 }
					),
				])
			);
			await waitFor(() => sentPackets(socket).some((packet) => packet.cmd === 'suback'));
			assert.deepStrictEqual(
				sentPackets(socket).map((packet) => packet.cmd),
				['connack', 'suback']
			);
			assert.ok(!socket.terminated);
		}
		assert.deepStrictEqual(
			sockets.map((socket) => socket.closes.length),
			[1, 0],
			'the second CONNECT took the session over'
		);
		for (const socket of sockets) socket.handlers.close();
	});

	it('publishes the will of a connection that was taken over, and keeps the will of the newer one', async () => {
		const { T, name } = topicTable();
		const open = mqttListener();
		const clientId = `will-${name}`;
		const withWill = (id) =>
			connectPacket(clientId, {
				will: { topic: `${name}/${id}`, payload: Buffer.from(JSON.stringify({ value: id })), qos: 0, retain: true },
			});
		const older = open();
		older.handlers.message(withWill('older'));
		await waitFor(() => older.sends.length > 0);
		const newer = open();
		newer.handlers.message(withWill('newer'));
		await waitFor(() => newer.sends.length > 0 && older.closes.length > 0);
		// the older connection's socket closes only after the newer one has stored its will
		older.handlers.close();
		await waitFor(async () => (await T.get('older'))?.value === 'older');
		assert.ok(!(await T.get('newer')), 'the newer connection is still connected');
		const wills = [];
		for await (const will of databases.system.hdb_session_will.search({})) {
			if (will.id[0] === clientId) wills.push(will.topic);
		}
		assert.deepStrictEqual(wills, [`${name}/newer`]);
		newer.handlers.close();
		await waitFor(async () => (await T.get('newer'))?.value === 'newer');
	});

	it('takes nothing over for a client that left while its CONNECT waited for an older save', async () => {
		const { T, name } = topicTable();
		const open = mqttListener();
		const clientId = `left-${name}`;
		const older = open();
		older.handlers.message(connectPacket(clientId));
		await waitFor(() => older.sends.length > 0);
		const olderSession = [...open.sessions].find((session) => session.sessionId === clientId);
		const saves = holdSaves();
		let newer;
		try {
			olderSession.persist();
			await waitFor(() => saves.held.length > 0);
			newer = open();
			newer.handlers.message(
				connectPacket(clientId, {
					will: {
						topic: `${name}/left`,
						payload: Buffer.from(JSON.stringify({ value: 'left' })),
						qos: 0,
						retain: true,
					},
				})
			);
			await waitFor(() => older.closes.length > 0);
			newer.handlers.close();
		} finally {
			saves.release();
		}
		await olderSession.writes;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepStrictEqual(newer.sends, [], 'nothing answers a client that is gone');
		assert.deepStrictEqual(
			[...open.sessions].filter((session) => session.sessionId === clientId),
			[olderSession],
			'no session is made for it'
		);
		assert.strictEqual((await stored(clientId)).incarnation, olderSession.incarnation, 'it did not claim the record');
		assert.ok(!(await T.get('left')), 'a CONNECT that never finished stored no will');
		older.handlers.close();
	});

	it('does not let a CONNECT whose client left while queued take over the session the CONNECT before it made', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const clientId = `left-queued-${name}`;
		const sessions = databases.system.hdb_durable_session;
		const get = sessions.get;
		let releaseRead;
		sessions.get = function (...args) {
			sessions.get = get;
			return new Promise((resolve) => (releaseRead = () => resolve(get.apply(this, args))));
		};
		const [first, queued] = [open(), open()];
		try {
			first.handlers.message(connectPacket(clientId));
			await waitFor(() => releaseRead);
			queued.handlers.message(connectPacket(clientId));
			await new Promise(setImmediate);
			queued.handlers.close();
		} finally {
			sessions.get = get;
		}
		releaseRead();
		await waitFor(() => first.sends.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.strictEqual(sentPackets(first)[0].reasonCode, 0);
		assert.deepStrictEqual(first.closes, [], 'the live connection keeps its session');
		assert.deepStrictEqual(queued.sends, []);
		first.handlers.close();
	});

	it('lets no SUBSCRIBE still in flight on a closed connection write the session after a reconnect', async () => {
		const { name } = topicTable();
		let releaseSubscribe;
		class Slow extends Resource {
			static subscribe() {
				return new Promise((resolve) => (releaseSubscribe = () => resolve(undefined)));
			}
		}
		Resources.resources.set(name, Slow, { mqtt: true }, true);
		const open = mqttListener();
		const clientId = `closed-subscribe-${name}`;
		const older = open();
		older.handlers.message(connectPacket(clientId));
		await waitFor(() => older.sends.length > 0);
		older.handlers.message(
			generate(
				{ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: `${name}/#`, qos: 1 }] },
				{ protocolVersion: 5 }
			)
		);
		await waitFor(() => releaseSubscribe);
		older.handlers.close();
		const newer = open();
		newer.handlers.message(connectPacket(clientId));
		await waitFor(() => newer.sends.length > 0);
		releaseSubscribe();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const newerSession = [...open.sessions].find((session) => session.sessionId === clientId);
		await newerSession.persist();
		assert.deepStrictEqual(newer.closes, [], 'the closed connection did not take the session back');
		assert.strictEqual((await stored(clientId)).incarnation, newerSession.incarnation);
		newer.handlers.close();
	});

	it('waits for the save a closed connection still has in flight before a reconnect takes the session over', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const clientId = `closing-${name}`;
		const older = open();
		older.handlers.message(connectPacket(clientId));
		await waitFor(() => older.sends.length > 0);
		const olderSession = [...open.sessions].find((session) => session.sessionId === clientId);
		// a stored record makes the reconnect write its takeover as it connects
		await olderSession.persist();
		const saves = holdSaves((record) => record.incarnation === olderSession.incarnation);
		let newer;
		try {
			olderSession.persist();
			await waitFor(() => saves.held.length > 0);
			older.handlers.close();
			newer = open();
			newer.handlers.message(connectPacket(clientId));
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			saves.release();
		}
		await waitFor(() => newer.sends.length > 0);
		const newerSession = [...open.sessions].find((session) => session.sessionId === clientId);
		await newerSession.persist();
		assert.deepStrictEqual(newer.closes, [], 'the older save landed first, so it never fenced the newer connection');
		assert.strictEqual((await stored(clientId)).incarnation, newerSession.incarnation);
		newer.handlers.close();
	});

	it('takes a session over from the last save that landed when an older save fails', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const clientId = `failed-save-${name}`;
		const older = open();
		older.handlers.message(connectPacket(clientId));
		await waitFor(() => older.sends.length > 0);
		const olderSession = [...open.sessions].find((session) => session.sessionId === clientId);
		await olderSession.persist();
		const sessions = databases.system.hdb_durable_session;
		const put = sessions.put;
		const failing = [];
		sessions.put = function (record, ...rest) {
			if (record.incarnation !== olderSession.incarnation) return put.call(this, record, ...rest);
			return new Promise((_resolve, reject) => failing.push(() => reject(new Error('system table unavailable'))));
		};
		let newer;
		try {
			olderSession.persist().catch(() => {});
			await waitFor(() => failing.length > 0);
			newer = open();
			newer.handlers.message(connectPacket(clientId));
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepStrictEqual(newer.sends, [], 'the CONNECT waits for the save in flight');
			for (const fail of failing) fail();
			await waitFor(() => newer.sends.length > 0);
		} finally {
			sessions.put = put;
		}
		const [connack] = sentPackets(newer);
		assert.strictEqual(connack.sessionPresent, true, 'it resumes the record the earlier save left');
		const newerSession = [...open.sessions].find(
			(session) => session.sessionId === clientId && session !== olderSession
		);
		assert.strictEqual((await stored(clientId)).incarnation, newerSession.incarnation);
		older.handlers.close();
		newer.handlers.close();
	});

	it('keeps a CONNECT that gave up waiting in line until the one before it finishes', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const clientId = `in-line-${name}`;
		const sessions = databases.system.hdb_durable_session;
		const get = sessions.get;
		let releaseRead;
		sessions.get = function (...args) {
			sessions.get = get;
			return new Promise((resolve) => (releaseRead = () => resolve(get.apply(this, args))));
		};
		const timeout = setTakeoverTimeoutForTests(50);
		const [first, second, third] = [open(), open(), open()];
		try {
			first.handlers.message(connectPacket(clientId));
			await waitFor(() => releaseRead);
			second.handlers.message(connectPacket(clientId));
			await waitFor(() => second.sends.length > 0);
			third.handlers.message(connectPacket(clientId));
			await waitFor(() => third.sends.length > 0);
		} finally {
			setTakeoverTimeoutForTests(timeout);
			sessions.get = get;
		}
		assert.deepStrictEqual(
			[second, third].map((socket) => sentPackets(socket)[0].reasonCode),
			[0x88, 0x88],
			'neither connects past the unfinished first'
		);
		releaseRead();
		await waitFor(() => first.sends.length > 0);
		assert.strictEqual(sentPackets(first)[0].reasonCode, 0);
		for (const socket of [first, second, third]) socket.handlers.close();
	});

	it('refuses a CONNECT whose takeover waits too long for an older save', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const clientId = `stalled-${name}`;
		const older = open();
		older.handlers.message(connectPacket(clientId));
		await waitFor(() => older.sends.length > 0);
		const olderSession = [...open.sessions].find((session) => session.sessionId === clientId);
		const saves = holdSaves();
		const timeout = setTakeoverTimeoutForTests(50);
		let newer;
		try {
			olderSession.persist();
			await waitFor(() => saves.held.length > 0);
			newer = open();
			newer.handlers.message(connectPacket(clientId));
			await waitFor(() => newer.sends.length > 0);
			const [connack] = sentPackets(newer);
			assert.strictEqual(connack.cmd, 'connack');
			assert.strictEqual(connack.reasonCode, 0x88, 'server unavailable');
		} finally {
			setTakeoverTimeoutForTests(timeout);
			saves.release();
		}
		older.handlers.close();
		newer.handlers.close();
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
		await T.put('a2', { value: 1.5 });
		await waitFor(() => first.received.length >= 2);
		await ackAll(first.session, first.received);
		first.session.checkpoint();
		await first.session.writes;
		const entry = (await stored(clientId)).subscriptions[0];
		assert.strictEqual(entry.databaseGeneration, undefined, 'LMDB has no generation to bind');
		assert.ok(entry.startTime >= first.session.topics.get(`${name}/#`).keyBefore, 'acks still advance it');
		first.session.disconnect(true);
		await T.put('b', { value: 2 });
		const second = await connect(clientId);
		assert.strictEqual(second.session.sessionWasPresent, true);
		await second.session.resume();
		await waitFor(() => values(second.received).includes(2));
		assert.ok(!values(second.received).includes(1), 'an acknowledged transaction is not redelivered');
		second.session.disconnect(true);
	});
});
