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

// its writes take its log key now, so it commits below whatever commits before the returned function is called
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

/** A topic over the table whose subscription certifies no progress, as a resource that is not a table. */
function uncertifiedTopic(T, name) {
	class Uncertified extends Resource {
		static async subscribe(request) {
			const inner = await T.subscribe({ startTime: request.startTime, omitCurrent: true });
			return { [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](), end: () => inner.end() };
		}
	}
	Resources.resources.set(`${name}Wrapped`, Uncertified, { mqtt: true });
	return `${name}Wrapped/#`;
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
		// the late transaction's first message never finishes sending, so its rest stays queued
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
		const topic = uncertifiedTopic(T, name);
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

	it('keeps an uncertified topic before a delivered transaction that committed after a higher key', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const topic = uncertifiedTopic(T, name);
		const clientId = `late-uncertified-${name}`;
		const { session, received } = await connect(clientId);
		await session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		const commitLate = await heldTransaction(T, 'late');
		await T.put('early', { value: 'early' });
		await waitFor(() => values(received).includes('early'));
		await commitLate();
		await waitFor(() => values(received).includes('late'));
		const state = session.topics.get(topic);
		assert.strictEqual(state.subscription.progress, undefined, 'the topic certifies no progress');
		const key = (value) => state.unacked.get(delivery(received, value).messageId).key;
		const lateKey = key('late');
		assert.ok(lateKey < key('early'), 'the late transaction holds the lower key');
		await session.acknowledge(delivery(received, 'early').messageId);
		assert.ok((await stored(clientId)).subscriptions[0].startTime < lateKey, 'the unacknowledged delivery is kept');
		session.disconnect(true);
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

describe('MQTT QoS 2 exactly-once exchanges', function () {
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});
	const v5 = { protocolVersion: 5 };
	const ofCommand = (socket, cmd) => sentPackets(socket).filter((packet) => packet.cmd === cmd);
	const payloadValue = (packet) => JSON.parse(packet.payload.toString()).value;

	async function openConnected(open, clientId) {
		const socket = open();
		socket.handlers.message(connectPacket(clientId));
		await waitFor(() => ofCommand(socket, 'connack').length > 0);
		return socket;
	}
	/** Resolves once `value` reaches the watcher, so every message published before it has been delivered too. */
	async function settled(socket, watcher, name, value) {
		socket.handlers.message(
			generate({ cmd: 'publish', topic: `${name}/marker`, payload: JSON.stringify({ value }), qos: 0 }, v5)
		);
		await waitFor(() => values(watcher.received).includes(value));
	}

	it('publishes a retransmitted QoS 2 PUBLISH once, and completes its release once', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const watcher = await connect(`qos2-in-watch-${name}`);
		await watcher.session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		const open = mqttListener();
		const socket = await openConnected(open, `qos2-in-${name}`);
		const publish = (dup) =>
			generate(
				{ cmd: 'publish', topic: `${name}/m`, payload: JSON.stringify({ value: 'once' }), qos: 2, messageId: 7, dup },
				v5
			);
		socket.handlers.message(publish(false));
		socket.handlers.message(publish(true));
		await waitFor(() => ofCommand(socket, 'pubrec').length === 2);
		assert.deepStrictEqual(
			ofCommand(socket, 'pubrec').map((packet) => [packet.messageId, packet.reasonCode]),
			[
				[7, 0],
				[7, 0],
			]
		);
		// a retransmitted PUBREL gets the PUBCOMP of the first, once its release is saved
		socket.handlers.message(generate({ cmd: 'pubrel', messageId: 7 }, v5));
		socket.handlers.message(generate({ cmd: 'pubrel', messageId: 7 }, v5));
		await waitFor(() => ofCommand(socket, 'pubcomp').length === 2);
		socket.handlers.message(generate({ cmd: 'pubrel', messageId: 7 }, v5));
		await waitFor(() => ofCommand(socket, 'pubcomp').length === 3);
		assert.deepStrictEqual(
			ofCommand(socket, 'pubcomp').map((packet) => packet.reasonCode),
			[0, 0, 0x92],
			'a PUBREL after the exchange ended finds no id'
		);
		await settled(socket, watcher, name, 'marker');
		assert.strictEqual(values(watcher.received).filter((value) => value === 'once').length, 1);
		socket.handlers.close();
		watcher.session.disconnect(true);
	});

	it('recognizes a QoS 2 retransmission after a reconnect, and forgets its id once released', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const watcher = await connect(`qos2-reconnect-watch-${name}`);
		await watcher.session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		const open = mqttListener();
		const clientId = `qos2-reconnect-${name}`;
		const publish = (dup) =>
			generate(
				{ cmd: 'publish', topic: `${name}/m`, payload: JSON.stringify({ value: 'again' }), qos: 2, messageId: 9, dup },
				v5
			);
		const first = await openConnected(open, clientId);
		first.handlers.message(publish(false));
		await waitFor(() => ofCommand(first, 'pubrec').length === 1);
		assert.deepStrictEqual((await stored(clientId)).awaitingRelease, [9], 'kept before the PUBREC went out');
		// the PUBREC is lost with the connection, so the client sends the PUBLISH again
		first.handlers.close();
		const second = await openConnected(open, clientId);
		second.handlers.message(publish(true));
		await waitFor(() => ofCommand(second, 'pubrec').length === 1);
		second.handlers.message(generate({ cmd: 'pubrel', messageId: 9 }, v5));
		await waitFor(() => ofCommand(second, 'pubcomp').length === 1);
		assert.strictEqual(ofCommand(second, 'pubcomp')[0].reasonCode, 0);
		assert.strictEqual((await stored(clientId)).awaitingRelease, undefined, 'released before the PUBCOMP went out');
		await settled(second, watcher, name, 'marker');
		assert.strictEqual(values(watcher.received).filter((value) => value === 'again').length, 1);
		second.handlers.close();
		watcher.session.disconnect(true);
	});

	it('publishes a QoS 2 PUBLISH again when the first attempt failed', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const socket = await openConnected(open, `qos2-failed-${name}`);
		const publish = () =>
			generate({ cmd: 'publish', topic: 'NoSuchTopic/m', payload: '{}', qos: 2, messageId: 11 }, v5);
		socket.handlers.message(publish());
		await waitFor(() => ofCommand(socket, 'pubrec').length === 1);
		socket.handlers.message(publish());
		await waitFor(() => ofCommand(socket, 'pubrec').length === 2);
		assert.deepStrictEqual(
			ofCommand(socket, 'pubrec').map((packet) => packet.reasonCode),
			[0x90, 0x90],
			'each attempt was handled'
		);
		socket.handlers.close();
	});

	it('sends a PUBREL again after a reconnect, rather than the message it releases', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const topic = `${name}/#`;
		const clientId = `qos2-out-${name}`;
		const first = await openConnected(open, clientId);
		first.handlers.message(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 2, rh: 2 }] }, v5));
		await waitFor(() => ofCommand(first, 'suback').length > 0);
		assert.deepStrictEqual(ofCommand(first, 'suback')[0].granted, [2]);
		await T.put('a', { value: 'a' });
		const [delivered] = await waitFor(() => {
			const publishes = ofCommand(first, 'publish');
			return publishes.length > 0 && publishes;
		});
		assert.strictEqual(delivered.qos, 2);
		first.handlers.message(generate({ cmd: 'pubrec', messageId: delivered.messageId }, v5));
		await waitFor(() => ofCommand(first, 'pubrel').length === 1);
		assert.deepStrictEqual(
			(await stored(clientId)).awaitingCompletion,
			[delivered.messageId],
			'kept before the PUBREL'
		);
		first.handlers.close();
		await T.put('b', { value: 'b' });
		const second = open();
		second.handlers.message(connectPacket(clientId));
		await waitFor(() => ofCommand(second, 'publish').some((packet) => payloadValue(packet) === 'b'));
		const sent = sentPackets(second);
		assert.deepStrictEqual(
			sent.slice(0, 2).map((packet) => [packet.cmd, packet.messageId]),
			[
				['connack', undefined],
				['pubrel', delivered.messageId],
			]
		);
		assert.ok(!ofCommand(second, 'publish').some((packet) => payloadValue(packet) === 'a'), 'not sent again');
		const resent = ofCommand(second, 'publish').find((packet) => payloadValue(packet) === 'b');
		assert.notStrictEqual(resent.messageId, delivered.messageId, 'an id awaiting PUBCOMP is not reused');
		second.handlers.message(generate({ cmd: 'pubcomp', messageId: delivered.messageId }, v5));
		await waitFor(async () => (await stored(clientId)).awaitingCompletion === undefined);
		second.handlers.close();
	});

	it('does not send again a QoS 2 message the client took ahead of an older one', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const topic = `${name}/#`;
		const clientId = `qos2-order-${name}`;
		const first = await openConnected(open, clientId);
		first.handlers.message(generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 2, rh: 2 }] }, v5));
		await waitFor(() => ofCommand(first, 'suback').length > 0);
		await T.put('a', { value: 'a' });
		await T.put('b', { value: 'b' });
		await waitFor(() => ofCommand(first, 'publish').length === 2);
		const b = ofCommand(first, 'publish').find((packet) => payloadValue(packet) === 'b');
		first.handlers.message(generate({ cmd: 'pubrec', messageId: b.messageId }, v5));
		await waitFor(() => ofCommand(first, 'pubrel').length === 1);
		assert.deepStrictEqual(
			(await stored(clientId)).subscriptions[0].receivedRuns?.length,
			1,
			'kept past the held position'
		);
		first.handlers.close();
		await T.put('c', { value: 'c' });
		const second = await openConnected(open, clientId);
		await waitFor(() => ofCommand(second, 'publish').some((packet) => payloadValue(packet) === 'c'));
		assert.deepStrictEqual(
			ofCommand(second, 'publish').map(payloadValue),
			['a', 'c'],
			'the unacknowledged message is sent again, the received one is not'
		);
		// once the older message is taken, the position passes both and the skip list is dropped
		for (const packet of ofCommand(second, 'publish'))
			second.handlers.message(generate({ cmd: 'pubrec', messageId: packet.messageId }, v5));
		await waitFor(() => ofCommand(second, 'pubrel').length === 3);
		// a quiet table certifies no position until a later write gives it a watermark
		await T.put('d', { value: 'd' });
		const d = await waitFor(() => ofCommand(second, 'publish').find((packet) => payloadValue(packet) === 'd'));
		second.handlers.message(generate({ cmd: 'pubrec', messageId: d.messageId }, v5));
		await waitFor(async () => {
			const [entry] = (await stored(clientId)).subscriptions;
			return entry.received === undefined && entry.receivedRuns === undefined;
		});
		second.handlers.close();
	});

	async function subscribed(open, clientId, topic) {
		const socket = await openConnected(open, clientId);
		socket.handlers.message(
			generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 2, rh: 2 }] }, v5)
		);
		await waitFor(() => ofCommand(socket, 'suback').length > 0);
		return socket;
	}
	const published = (socket, value) => ofCommand(socket, 'publish').find((packet) => payloadValue(packet) === value);

	it('sends a QoS 2 message again under its packet id, as a DUP, when its PUBREC never arrived', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-dup-${name}`;
		const first = await subscribed(open, clientId, `${name}/#`);
		await T.put('a', { value: 'a' });
		const sent = await waitFor(() => published(first, 'a'));
		assert.strictEqual(sent.dup, false);
		first.handlers.close();
		const second = await openConnected(open, clientId);
		const resent = await waitFor(() => published(second, 'a'));
		assert.strictEqual(resent.messageId, sent.messageId);
		assert.strictEqual(resent.dup, true);
		second.handlers.close();
	});

	describe('a restored topic whose resume found no live subscription', () => {
		async function subscribeAt(socket, topic, qos, messageId) {
			socket.handlers.message(generate({ cmd: 'subscribe', messageId, subscriptions: [{ topic, qos, rh: 2 }] }, v5));
			await waitFor(() => ofCommand(socket, 'suback').some((packet) => packet.messageId === messageId));
			assert.deepStrictEqual(ofCommand(socket, 'suback').find((packet) => packet.messageId === messageId).granted, [
				qos,
			]);
		}
		/** Reconnects a saved session while its resource subscribes to nothing, leaving the topic restored but not live. */
		async function reconnectWithoutSubscription(open, T, name, clientId, topic) {
			let attempts = 0;
			// the table's own audit store, so the saved receipts still name this database generation
			class Silent extends T {
				static subscribe() {
					attempts++;
				}
			}
			Resources.resources.set(name, Silent, { mqtt: true }, true);
			let socket;
			try {
				socket = await openConnected(open, clientId);
				await waitFor(() => attempts > 0);
				const session = [...open.sessions].find((session) => session.sessionId === clientId);
				await session.changes;
				const restored = session.topics.get(topic);
				assert.ok(restored, 'the topic is restored');
				assert.strictEqual(restored.subscription, undefined, 'and has no live subscription');
				return { socket, session, restored };
			} finally {
				Resources.resources.set(name, T, { mqtt: true }, true);
			}
		}
		/** A QoS 2 session holding a delivery awaiting its PUBREC (`a`) behind one whose PUBREC arrived (`b`). */
		async function savedQoS2(open, T, clientId, topic) {
			const socket = await subscribed(open, clientId, topic);
			await T.put('a', { value: 'a' });
			await T.put('b', { value: 'b' });
			await waitFor(() => published(socket, 'b'));
			const a = published(socket, 'a');
			socket.handlers.message(generate({ cmd: 'pubrec', messageId: published(socket, 'b').messageId }, v5));
			await waitFor(() => ofCommand(socket, 'pubrel').length === 1);
			await storedEntry(clientId, (entry) => entry.receivedRuns?.length > 0 && entry.inFlight?.length > 0);
			socket.handlers.close();
			return a;
		}

		it('releases its receipts and packet ids when it is subscribed again at QoS 1', async () => {
			const { T, name } = topicTable();
			await T.put('seed', { value: 0 });
			const open = mqttListener();
			const topic = `${name}/#`;
			const clientId = `qos2-to-1-${name}`;
			const a = await savedQoS2(open, T, clientId, topic);
			const { socket, session, restored } = await reconnectWithoutSubscription(open, T, name, clientId, topic);
			try {
				assert.strictEqual(restored.entry.qos, 2);
				assert.ok(session.receivedCount > 0, 'receipts are restored');
				assert.ok(session.reservedIds.has(a.messageId), 'and the id of the delivery awaiting its PUBREC is reserved');
				await subscribeAt(socket, topic, 1, 2);
				assert.strictEqual(session.topics.get(topic).entry.qos, 1);
				assert.strictEqual(session.receivedCount, 0);
				assert.ok(!session.reservedIds.has(a.messageId));
				const saved = (await stored(clientId)).subscriptions[0];
				assert.strictEqual(saved.qos, 1);
				for (const field of ['received', 'receivedRuns', 'receivedThrough', 'inFlight', 'receiptsGeneration'])
					assert.strictEqual(saved[field], undefined, `${field} is not saved for a QoS 1 topic`);
			} finally {
				socket.handlers.close();
			}
		});

		it('tracks its deliveries for PUBREC when it is subscribed again at QoS 2', async () => {
			const { T, name } = topicTable();
			await T.put('seed', { value: 0 });
			const open = mqttListener();
			const topic = `${name}/#`;
			const clientId = `qos1-to-2-${name}`;
			const first = await openConnected(open, clientId);
			await subscribeAt(first, topic, 1, 1);
			await T.put('a', { value: 'a' });
			await waitFor(() => published(first, 'a'));
			first.handlers.message(generate({ cmd: 'puback', messageId: published(first, 'a').messageId }, v5));
			await storedEntry(clientId, (entry) => entry.databaseGeneration !== undefined || !isRocksDB);
			first.handlers.close();
			const { socket: second, session, restored } = await reconnectWithoutSubscription(open, T, name, clientId, topic);
			assert.strictEqual(restored.entry.qos, 1);
			await subscribeAt(second, topic, 2, 2);
			assert.strictEqual(session.topics.get(topic).entry.qos, 2);
			await T.put('c', { value: 'c' });
			const sent = await waitFor(() => published(second, 'c'));
			assert.strictEqual(sent.qos, 2);
			session.checkpoint();
			const saved = await storedEntry(clientId, (entry) => entry.qos === 2 && entry.inFlight?.length > 0);
			assert.strictEqual(saved.inFlight[0][3], sent.messageId, 'the delivery awaiting its PUBREC is saved');
			second.handlers.close();
			const third = await openConnected(open, clientId);
			try {
				const resent = await waitFor(() => published(third, 'c'));
				assert.strictEqual(resent.qos, 2);
				assert.strictEqual(resent.messageId, sent.messageId);
				assert.strictEqual(resent.dup, true);
				third.handlers.message(generate({ cmd: 'pubrec', messageId: sent.messageId }, v5));
				await waitFor(() => ofCommand(third, 'pubrel').length === 1);
			} finally {
				third.handlers.close();
			}
		});

		it('keeps its receipts and packet ids when it is subscribed again at QoS 2', async () => {
			const { T, name } = topicTable();
			await T.put('seed', { value: 0 });
			const open = mqttListener();
			const topic = `${name}/#`;
			const clientId = `qos2-to-2-${name}`;
			const a = await savedQoS2(open, T, clientId, topic);
			const { socket, session } = await reconnectWithoutSubscription(open, T, name, clientId, topic);
			try {
				const receipts = session.receivedCount;
				assert.ok(receipts > 0);
				assert.ok(session.reservedIds.has(a.messageId));
				await subscribeAt(socket, topic, 2, 2);
				assert.strictEqual(session.topics.get(topic).entry.qos, 2);
				assert.strictEqual(session.receivedCount, receipts);
				const resent = await waitFor(() => published(socket, 'a'));
				assert.strictEqual(resent.messageId, a.messageId, 'the delivery with no PUBREC keeps its id');
				assert.strictEqual(resent.dup, true);
				session.checkpoint();
				const saved = await storedEntry(clientId, (entry) => entry.qos === 2 && entry.receivedRuns?.length > 0);
				assert.strictEqual(saved.inFlight[0][3], a.messageId);
				assert.ok(!published(socket, 'b'), 'the delivery whose PUBREC arrived is not sent again');
			} finally {
				socket.handlers.close();
			}
		});
	});

	it('tells apart a record published twice in one transaction, live and on a replay', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-repeat-${name}`;
		const first = await subscribed(open, clientId, `${name}/#`);
		await T.put('held', { value: 'held' });
		await waitFor(() => published(first, 'held'));
		await transaction({}, async (context) => {
			await T.publish('r', { value: 'r1' }, context);
			await T.publish('r', { value: 'r2' }, context);
		});
		const r1 = await waitFor(() => published(first, 'r1'));
		await waitFor(() => published(first, 'r2'));
		first.handlers.message(generate({ cmd: 'pubrec', messageId: r1.messageId }, v5));
		await waitFor(() => ofCommand(first, 'pubrel').length === 1);
		first.handlers.close();
		await T.put('after', { value: 'after' });
		const second = await openConnected(open, clientId);
		await waitFor(() => published(second, 'after'));
		assert.deepStrictEqual(
			ofCommand(second, 'publish').map(payloadValue),
			['held', 'r2', 'after'],
			'only the publication the client took is skipped'
		);
		second.handlers.close();
	});

	it('sends a PUBREL, a repeated one included, only once the save it waits for has landed', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-barrier-${name}`;
		const socket = await subscribed(open, clientId, `${name}/#`);
		await T.put('a', { value: 'a' });
		const sent = await waitFor(() => published(socket, 'a'));
		const saves = holdSaves((record) => record.id === clientId);
		try {
			socket.handlers.message(generate({ cmd: 'pubrec', messageId: sent.messageId }, v5));
			socket.handlers.message(generate({ cmd: 'pubrec', messageId: sent.messageId }, v5));
			await waitFor(() => saves.held.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(ofCommand(socket, 'pubrel').length, 0, 'nothing released before the save');
		} finally {
			saves.release();
		}
		await waitFor(() => ofCommand(socket, 'pubrel').length === 2);
		socket.handlers.close();
	});

	it('withholds the PUBREL and disconnects when its save fails', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-save-fails-${name}`;
		const socket = await subscribed(open, clientId, `${name}/#`);
		await T.put('a', { value: 'a' });
		const sent = await waitFor(() => published(socket, 'a'));
		const sessions = databases.system.hdb_durable_session;
		const put = sessions.put;
		sessions.put = function (record, ...rest) {
			if (record.id === clientId) return Promise.reject(new Error('disk full'));
			return put.call(this, record, ...rest);
		};
		try {
			socket.handlers.message(generate({ cmd: 'pubrec', messageId: sent.messageId }, v5));
			await waitFor(() => ofCommand(socket, 'disconnect').length > 0);
			assert.strictEqual(ofCommand(socket, 'pubrel').length, 0);
		} finally {
			sessions.put = put;
		}
		socket.handlers.close();
	});

	it('answers a PUBREC for a packet id it never sent with 0x92, owing nothing', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-unknown-${name}`;
		const socket = await subscribed(open, clientId, `${name}/#`);
		socket.handlers.message(generate({ cmd: 'pubrec', messageId: 4242 }, v5));
		await waitFor(() => ofCommand(socket, 'pubrel').length === 1);
		assert.strictEqual(ofCommand(socket, 'pubrel')[0].reasonCode, 0x92);
		const session = [...open.sessions].find((session) => session.sessionId === clientId);
		assert.ok(!session.awaitingCompletion?.has(4242));
		socket.handlers.close();
	});

	it('publishes a retransmitted QoS 2 PUBLISH once on MQTT 3.1.1', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const watcher = await connect(`qos2-v4-watch-${name}`);
		await watcher.session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		const open = mqttListener();
		const v4 = { protocolVersion: 4 };
		const socket = open();
		socket.handlers.message(
			generate(
				{ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: `qos2-v4-${name}`, clean: false },
				v4
			)
		);
		await waitFor(() => ofCommand(socket, 'connack').length > 0);
		const publish = (dup) =>
			generate(
				{ cmd: 'publish', topic: `${name}/m`, payload: JSON.stringify({ value: 'v4' }), qos: 2, messageId: 3, dup },
				v4
			);
		socket.handlers.message(publish(false));
		socket.handlers.message(publish(true));
		await waitFor(() => ofCommand(socket, 'pubrec').length === 2);
		socket.handlers.message(generate({ cmd: 'pubrel', messageId: 3 }, v4));
		await waitFor(() => ofCommand(socket, 'pubcomp').length === 1);
		socket.handlers.message(
			generate({ cmd: 'publish', topic: `${name}/marker`, payload: '{"value":"m"}', qos: 0 }, v4)
		);
		await waitFor(() => values(watcher.received).includes('m'));
		assert.strictEqual(values(watcher.received).filter((value) => value === 'v4').length, 1);
		socket.handlers.close();
		watcher.session.disconnect(true);
	});

	it('refuses to assign a packet id when every one is in flight', async () => {
		const { name } = topicTable();
		const { session } = await connect(`qos2-exhausted-${name}`);
		session.awaitingAcks = new Map();
		for (let messageId = 1; messageId <= 65500; messageId++) session.awaitingAcks.set(messageId, {});
		assert.throws(() => session.newMessageId(), { code: 'MESSAGE_IDS_EXHAUSTED' });
		session.awaitingAcks = new Map();
		session.disconnect(true);
	});

	it('keeps the id of a QoS 2 PUBLISH still committing when its connection closes', async () => {
		const { name } = topicTable();
		const publications = [];
		let commit;
		class SlowPublish extends Resource {
			static publish(_target, data) {
				publications.push(data);
				if (publications.length > 1) return;
				return new Promise((resolve) => (commit = resolve));
			}
		}
		Resources.resources.set(name, SlowPublish, { mqtt: true }, true);
		const open = mqttListener();
		const clientId = `qos2-closing-${name}`;
		const publish = (dup) =>
			generate({ cmd: 'publish', topic: `${name}/m`, payload: '{"value":1}', qos: 2, messageId: 5, dup }, v5);
		const first = await openConnected(open, clientId);
		first.handlers.message(publish(false));
		await waitFor(() => commit);
		first.handlers.close();
		commit();
		const second = await openConnected(open, clientId);
		second.handlers.message(publish(true));
		await waitFor(() => ofCommand(second, 'pubrec').length === 1);
		assert.strictEqual(publications.length, 1, 'the retransmission was not published again');
		second.handlers.close();
	});

	it('keeps every id still committing when a connection closes, whichever finishes first', async () => {
		const { name } = topicTable();
		const publications = [];
		const commits = [];
		class SlowPublish extends Resource {
			static publish(_target, data) {
				publications.push(data);
				if (publications.length > 2) return;
				return new Promise((resolve) => commits.push(resolve));
			}
		}
		Resources.resources.set(name, SlowPublish, { mqtt: true }, true);
		const open = mqttListener();
		const clientId = `qos2-closing-two-${name}`;
		const publish = (messageId, dup) =>
			generate({ cmd: 'publish', topic: `${name}/m`, payload: '{"value":1}', qos: 2, messageId, dup }, v5);
		const first = await openConnected(open, clientId);
		first.handlers.message(publish(5, false));
		first.handlers.message(publish(6, false));
		await waitFor(() => commits.length === 2);
		first.handlers.close();
		commits[0]();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = open();
		second.handlers.message(connectPacket(clientId));
		await new Promise((resolve) => setTimeout(resolve, 20));
		commits[1]();
		await waitFor(() => ofCommand(second, 'connack').length > 0);
		second.handlers.message(publish(6, true));
		await waitFor(() => ofCommand(second, 'pubrec').length === 1);
		assert.strictEqual(publications.length, 2, 'the retransmission was not published again');
		second.handlers.close();
	});

	it('sends a delivery awaiting its PUBREC under its packet id when its topic is subscribed again', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const topic = `${name}/#`;
		const socket = await subscribed(open, `qos2-resubscribe-${name}`, topic);
		await T.put('a', { value: 'a' });
		await T.put('b', { value: 'b' });
		await waitFor(() => published(socket, 'b'));
		const [a, b] = [published(socket, 'a'), published(socket, 'b')];
		socket.handlers.message(
			generate({ cmd: 'subscribe', messageId: 2, subscriptions: [{ topic, qos: 2, rh: 2 }] }, v5)
		);
		await waitFor(() => ofCommand(socket, 'suback').length === 2);
		// a PUBREC racing the replacement's replay: either way b keeps its id
		socket.handlers.message(generate({ cmd: 'pubrec', messageId: b.messageId }, v5));
		await waitFor(() => ofCommand(socket, 'publish').some((packet) => packet.dup));
		await T.put('c', { value: 'c' });
		await waitFor(() => published(socket, 'c'));
		for (const [value, original] of [
			['a', a],
			['b', b],
		]) {
			const sends = ofCommand(socket, 'publish').filter((packet) => payloadValue(packet) === value);
			assert.ok(
				sends.every((packet) => packet.messageId === original.messageId),
				`${value} is only ever sent under its first packet id`
			);
			assert.ok(
				sends.slice(1).every((packet) => packet.dup),
				`${value} is sent again as a DUP`
			);
		}
		assert.ok(
			ofCommand(socket, 'publish').some((packet) => packet.dup && payloadValue(packet) === 'a'),
			'the delivery with no PUBREC is sent again'
		);
		socket.handlers.close();
	});

	it('saves the packet ids of deliveries awaiting PUBREC at a checkpoint', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-checkpoint-${name}`;
		const socket = await subscribed(open, clientId, `${name}/#`);
		await T.put('a', { value: 'a' });
		const a = await waitFor(() => published(socket, 'a'));
		const session = [...open.sessions].find((session) => session.sessionId === clientId);
		session.checkpoint();
		const entry = await storedEntry(clientId, (entry) => entry.inFlight?.length > 0);
		assert.strictEqual(entry.inFlight[0][3], a.messageId);
		socket.handlers.close();
	});

	it('settles an exchange save once a save including it lands, while later saves keep running', async () => {
		const { name } = topicTable();
		const { session } = await connect(`qos2-busy-${name}`);
		await session.persist();
		const sessions = databases.system.hdb_durable_session;
		const put = sessions.put;
		let puts = 0;
		sessions.put = function (...args) {
			if (args[0]?.id === session.sessionId && ++puts < 50) session.dirty = true;
			return put.apply(this, args);
		};
		try {
			await session.saveExchanges();
			assert.ok(puts <= 2, `settled after ${puts} saves`);
			assert.ok(session.saving, 'the save loop is still running');
			await session.saving;
		} finally {
			sessions.put = put;
		}
		session.disconnect(true);
	});

	it('keeps a transaction taken in order behind a held delivery as one entry', async function () {
		// LMDB gives each event its own log key, so there is no shared key to run along
		if (!isRocksDB) this.skip();
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-run-${name}`;
		const socket = await subscribed(open, clientId, `${name}/#`);
		await T.put('held', { value: 'held' });
		await waitFor(() => published(socket, 'held'));
		await transaction({}, async (context) => {
			for (let i = 0; i < 50; i++) await T.put(`r${i}`, { value: `r${i}` }, context);
		});
		await waitFor(() => published(socket, 'r49'));
		for (let i = 0; i < 50; i++)
			socket.handlers.message(generate({ cmd: 'pubrec', messageId: published(socket, `r${i}`).messageId }, v5));
		await waitFor(() => ofCommand(socket, 'pubrel').length === 50);
		const [entry] = (await stored(clientId)).subscriptions;
		assert.strictEqual(entry.received, undefined);
		assert.deepStrictEqual(
			entry.receivedRuns.map(([, count]) => count),
			[50]
		);
		socket.handlers.close();
		const second = await openConnected(open, clientId);
		await waitFor(() => published(second, 'held'));
		await T.put('after', { value: 'after' });
		await waitFor(() => published(second, 'after'));
		assert.deepStrictEqual(ofCommand(second, 'publish').map(payloadValue), ['held', 'after']);
		second.handlers.close();
	});

	it('sends none of what a replay with a pinned position delivered and the client took again', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-quiet-${name}`;
		const first = await subscribed(open, clientId, `${name}/#`);
		await T.put('w', { value: 'w' });
		const w = await waitFor(() => published(first, 'w'));
		first.handlers.message(generate({ cmd: 'pubrec', messageId: w.messageId }, v5));
		await waitFor(() => ofCommand(first, 'pubrel').length === 1);
		first.handlers.message(generate({ cmd: 'pubcomp', messageId: w.messageId }, v5));
		await waitFor(async () => (await stored(clientId)).awaitingCompletion === undefined);
		first.handlers.close();
		for (let i = 0; i < 20; i++) await T.put(`q${i}`, { value: `q${i}` });
		const second = await openConnected(open, clientId);
		await waitFor(() => published(second, 'q19'));
		// as when nothing else commits during the replay: the position stays at the resume start
		const state = [...open.sessions]
			.find((session) => session.sessionId === clientId && !session.terminated)
			.topics.get(`${name}/#`);
		const resumedAt = state.entry.startTime;
		state.subscription.progress = () => resumedAt;
		for (const packet of ofCommand(second, 'publish'))
			second.handlers.message(generate({ cmd: 'pubrec', messageId: packet.messageId }, v5));
		await waitFor(() => ofCommand(second, 'pubrel').length === ofCommand(second, 'publish').length);
		second.handlers.close();
		const third = await openConnected(open, clientId);
		await T.put('after', { value: 'after' });
		await waitFor(() => published(third, 'after'));
		assert.deepStrictEqual(ofCommand(third, 'publish').map(payloadValue), ['after']);
		third.handlers.close();
	});

	it('restores no receipts saved against another database generation', async function () {
		if (!isRocksDB) this.skip();
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-generation-${name}`;
		const first = await subscribed(open, clientId, `${name}/#`);
		await T.put('a', { value: 'a' });
		await T.put('b', { value: 'b' });
		await waitFor(() => published(first, 'b'));
		first.handlers.message(generate({ cmd: 'pubrec', messageId: published(first, 'b').messageId }, v5));
		await waitFor(() => ofCommand(first, 'pubrel').length === 1);
		first.handlers.close();
		const record = await stored(clientId);
		await waitFor(() => !open.sessions.size || [...open.sessions].every((session) => session.sealed));
		// as when the record replicated from another node, whose log keys name nothing here
		await databases.system.hdb_durable_session.put({
			...record,
			subscriptions: record.subscriptions.map((entry) => ({ ...entry, receiptsGeneration: 'elsewhere' })),
		});
		const second = await openConnected(open, clientId);
		await waitFor(() => published(second, 'b'));
		second.handlers.close();
	});

	it('retries a failed PUBREL save when the PUBREC is repeated', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const open = mqttListener();
		const clientId = `qos2-retry-${name}`;
		const socket = await subscribed(open, clientId, `${name}/#`);
		await T.put('a', { value: 'a' });
		const sent = await waitFor(() => published(socket, 'a'));
		const sessions = databases.system.hdb_durable_session;
		const put = sessions.put;
		sessions.put = function (record, ...rest) {
			if (record.id === clientId) return Promise.reject(new Error('disk full'));
			return put.call(this, record, ...rest);
		};
		try {
			socket.handlers.message(generate({ cmd: 'pubrec', messageId: sent.messageId }, v5));
			await waitFor(() => ofCommand(socket, 'disconnect').length > 0);
		} finally {
			sessions.put = put;
		}
		socket.handlers.message(generate({ cmd: 'pubrec', messageId: sent.messageId }, v5));
		await waitFor(() => ofCommand(socket, 'pubrel').length === 1);
		assert.strictEqual(ofCommand(socket, 'pubrel')[0].reasonCode, 0);
		assert.deepStrictEqual((await stored(clientId)).awaitingCompletion, [sent.messageId]);
		socket.handlers.close();
	});

	it('advertises a Receive Maximum and disconnects a client that holds more QoS 2 exchanges open', async () => {
		const { name } = topicTable();
		const open = mqttListener();
		const clientId = `qos2-receive-maximum-${name}`;
		const socket = await openConnected(open, clientId);
		assert.strictEqual(ofCommand(socket, 'connack')[0].properties.receiveMaximum, 1000);
		const session = [...open.sessions].find((session) => session.sessionId === clientId);
		session.awaitingRelease = new Map();
		for (let messageId = 1; messageId <= 1000; messageId++)
			session.awaitingRelease.set(messageId, { reply: Promise.resolve({}), published: true });
		socket.handlers.message(
			generate({ cmd: 'publish', topic: `${name}/m`, payload: '{}', qos: 2, messageId: 2000 }, v5)
		);
		await waitFor(() => ofCommand(socket, 'disconnect').length > 0);
		assert.strictEqual(ofCommand(socket, 'disconnect')[0].reasonCode, 0x93);
		assert.strictEqual(ofCommand(socket, 'pubrec').length, 0);
		session.awaitingRelease = new Map();
		socket.handlers.close();
	});

	it('publishes a retransmitted QoS 2 PUBLISH once on a clean session', async () => {
		const { T, name } = topicTable();
		await T.put('seed', { value: 0 });
		const watcher = await connect(`qos2-clean-watch-${name}`);
		await watcher.session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		const open = mqttListener();
		const socket = open();
		socket.handlers.message(connectPacket(`qos2-clean-${name}`, { clean: true }));
		await waitFor(() => ofCommand(socket, 'connack').length > 0);
		const publish = (dup) =>
			generate(
				{ cmd: 'publish', topic: `${name}/m`, payload: JSON.stringify({ value: 'clean' }), qos: 2, messageId: 8, dup },
				v5
			);
		socket.handlers.message(publish(false));
		socket.handlers.message(publish(true));
		await waitFor(() => ofCommand(socket, 'pubrec').length === 2);
		socket.handlers.message(generate({ cmd: 'pubrel', messageId: 8 }, v5));
		await waitFor(() => ofCommand(socket, 'pubcomp').length === 1);
		assert.strictEqual(ofCommand(socket, 'pubcomp')[0].reasonCode, 0);
		await settled(socket, watcher, name, 'marker');
		assert.strictEqual(values(watcher.received).filter((value) => value === 'clean').length, 1);
		socket.handlers.close();
		watcher.session.disconnect(true);
	});

	it('assigns no packet id still awaiting its PUBCOMP', async () => {
		const { name } = topicTable();
		const { session } = await connect(`qos2-ids-${name}`);
		const first = session.newMessageId();
		session.awaitingCompletion = new Map([[first + 1, true]]);
		assert.strictEqual(session.newMessageId(), first + 2);
		session.disconnect(true);
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

describe('MQTT durable record topics on resume', function () {
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	for (const qos of [1, 2]) {
		it(`does not resend the record it already delivered (QoS ${qos})`, async () => {
			const { T, name } = topicTable();
			const topic = `${name}/r`;
			const clientId = `record-resume-${qos}-${name}`;
			await T.put('r', { value: 0 });
			const first = await connect(clientId);
			await first.session.addSubscription({ topic, qos, rh: 2 }, true);
			await T.put('r', { value: 1 });
			await waitFor(() => values(first.received).includes(1));
			const deliveredKey = first.session.topics.get(topic).deliveredKey;
			await ackAll(first.session, first.received);
			await storedEntry(clientId, (entry) => entry.startTime >= deliveredKey);
			first.session.disconnect(true);
			await first.session.writes;

			const second = await connect(clientId);
			const requests = [];
			const resumeSubscription = second.session.resumeSubscription;
			second.session.resumeSubscription = function (request, ...rest) {
				requests.push(request);
				return resumeSubscription.call(this, request, ...rest);
			};
			await second.session.resume();
			await T.put('r', { value: 2 });
			await waitFor(() => values(second.received).includes(2));
			assert.deepStrictEqual(values(second.received), [2], 'the acknowledged version is not sent again');
			assert.strictEqual(requests[0].rh, 2, 'a resumed subscription asks for no retained values');
			second.session.disconnect(true);
		});
	}

	it('sends no current value to a request that asks to omit it, whatever its retain handling', async () => {
		const { T, name } = topicTable();
		await T.put('r', { value: 0 });
		const { session, received } = await connect(`omit-current-${name}`);
		await session.addSubscription({ topic: `${name}/r`, qos: 1, omitCurrent: true }, true);
		await T.put('r', { value: 1 });
		await waitFor(() => values(received).includes(1));
		assert.deepStrictEqual(values(received), [1]);
		session.disconnect(true);
	});

	it('delivers only the newest version once when the record changed while away', async () => {
		const { T, name } = topicTable();
		const topic = `${name}/r`;
		const clientId = `record-changed-${name}`;
		await T.put('r', { value: 0 });
		const first = await connect(clientId);
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		await T.put('r', { value: 1 });
		await waitFor(() => values(first.received).includes(1));
		const deliveredKey = first.session.topics.get(topic).deliveredKey;
		await ackAll(first.session, first.received);
		await storedEntry(clientId, (entry) => entry.startTime >= deliveredKey);
		first.session.disconnect(true);
		await first.session.writes;
		await T.put('r', { value: 2 });

		const second = await connect(clientId);
		await second.session.resume();
		await T.put('r', { value: 3 });
		await waitFor(() => values(second.received).includes(3));
		assert.deepStrictEqual(values(second.received), [2, 3]);
		second.session.disconnect(true);
	});
});
