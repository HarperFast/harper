const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getDatabaseGeneration } = require('#src/resources/auditStore');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { LOG_CURSORS } = require('#src/resources/subscriptionCheckpoint');
const { transaction } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { getThisNodeName } = require('#src/server/nodeName');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const user = { username: 'mqtt-cursor-test', role: { permission: { super_user: true } } };

let sequence = 0;
/** A topic table in a database of its own, so its transaction logs hold only what the test writes. */
function topicTable(database) {
	const name = `CursorTopic${++sequence}`;
	const T = table({
		table: name,
		database: database ?? `cursor_${name}`,
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

function resumeRequests(session) {
	const requests = [];
	const resumeSubscription = session.resumeSubscription;
	session.resumeSubscription = function (request, ...rest) {
		requests.push(request);
		return resumeSubscription.call(this, request, ...rest);
	};
	return requests;
}

const stored = (clientId) => databases.system.hdb_durable_session.get(clientId);
const values = (received) => received.map(({ message }) => message?.value);
const delivery = (received, value) => received.find(({ message }) => message?.value === value);

/** Applies a publish as replication does: logged in the origin's log under the origin's key, whenever it arrives. */
function applyFromOrigin(T, nodeId, logKey, id) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await T.getResource(id, context);
		resource._writePublish(id, { value: id }, { isNotification: true, nodeId, version: logKey });
	});
}

async function take(session, deliveries, qos) {
	for (const { messageId } of deliveries) {
		if (qos === 2) await session.received(messageId, false);
		else await session.acknowledge(messageId);
	}
}

/** Saves the session's positions as its checkpoint timer does, and returns the stored record. */
async function save(session, clientId) {
	session.checkpoint();
	await session.writes;
	return stored(clientId);
}

async function end(connection) {
	connection.session.disconnect(true);
	await connection.session.writes;
}

/**
 * A session subscribed to the table's wildcard topic that has taken `taken` from a peer and `local` from this
 * node and saved a position above `lateKey`, a key between them that the peer has not used. No checkpoint exists:
 * nothing certifies the peer's route.
 */
async function savedSession(qos, { disconnect = true } = {}) {
	const { T, name } = topicTable();
	await T.put('seed', { value: 0 });
	const clientId = `cursor-${name}`;
	const topic = `${name}/#`;
	const peerName = `peer-${name}`;
	const peer = getIdOfRemoteNode(peerName, T.auditStore);
	const first = await connect(clientId);
	await first.session.addSubscription({ topic, qos, rh: 2 }, true);
	const peerKey = Date.now();
	await applyFromOrigin(T, peer, peerKey, 'taken');
	await waitFor(() => values(first.received).includes('taken'));
	await sleep(5);
	await T.put('local', { value: 'local' });
	await waitFor(() => values(first.received).includes('local'));
	await take(first.session, first.received, qos);
	const lateKey = peerKey + 1;
	let record;
	await waitFor(async () => {
		record = await save(first.session, clientId);
		return record?.subscriptions?.[0]?.startTime > lateKey;
	}, 10_000);
	if (disconnect) {
		await end(first);
		record = await stored(clientId);
	}
	return { T, name, topic, clientId, peer, peerName, peerKey, lateKey, first, record };
}

async function resumed(T, clientId, { live = 'after' } = {}) {
	const connection = await connect(clientId);
	assert.strictEqual(connection.session.sessionWasPresent, true);
	connection.requests = resumeRequests(connection.session);
	await connection.session.resume();
	if (live) {
		await T.put(live, { value: live });
		await waitFor(() => values(connection.received).includes(live));
	}
	return connection;
}

describe('MQTT durable sessions with a position per transaction log (harper#3790)', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('saves the read position of every log by origin name, with no checkpoint', async () => {
		const { T, name, peerName, peerKey, record } = await savedSession(1);
		const entry = record.subscriptions[0];
		assert.strictEqual(entry.checkpoint, undefined, 'nothing certifies the peer, so no checkpoint was issued');
		assert.deepStrictEqual(entry.cursors, [], 'the topic holds no log below what the database has read');
		const shared = record.cursors[`cursor_${name}`];
		assert.strictEqual(shared.generation, getDatabaseGeneration(T.auditStore).id);
		const logs = new Map(shared.logs);
		assert.deepStrictEqual([...logs.keys()].sort(), [getThisNodeName(), peerName].sort());
		assert.strictEqual(logs.get(peerName), peerKey, "the peer's log is read through its last entry");
		assert.ok(logs.get(getThisNodeName()) > peerKey, "and this node's through its own");
		assert.strictEqual(entry.takenThrough, undefined);
	});

	for (const qos of [1, 2]) {
		it(`QoS ${qos}: delivers once a transaction a peer commits below the saved position after the save`, async () => {
			const { T, clientId, peer, lateKey, record } = await savedSession(qos);
			const entry = record.subscriptions[0];
			await applyFromOrigin(T, peer, lateKey, 'late');
			const second = await resumed(T, clientId);
			assert.ok(second.requests[0][LOG_CURSORS].logs instanceof Map, 'resumed from its log positions');
			assert.strictEqual(second.requests[0].startTime, entry.startTime);
			assert.deepStrictEqual(values(second.received), ['late', 'after'], 'and nothing acknowledged is sent again');
			await take(second.session, second.received, qos);
			await end(second);
			const saved = (await stored(clientId)).subscriptions[0];
			assert.ok(saved.startTime >= entry.startTime, 'the saved position is never lowered');
			const third = await resumed(T, clientId, { live: 'later' });
			assert.deepStrictEqual(values(third.received), ['later'], 'once taken it is not sent again');
			await end(third);
		});

		it(`QoS ${qos}: sends again a late delivery below the position that was not acknowledged`, async () => {
			const { T, clientId, peer, lateKey, first } = await savedSession(qos, { disconnect: false });
			await applyFromOrigin(T, peer, lateKey, 'late');
			await waitFor(() => values(first.received).includes('late'));
			const sent = delivery(first.received, 'late');
			await end(first);
			const entry = (await stored(clientId)).subscriptions[0];
			assert.ok(entry.startTime > lateKey, 'the position stays above it');
			assert.ok(entry.takenThrough < lateKey, 'and what was taken is recorded below it');
			const second = await resumed(T, clientId);
			assert.deepStrictEqual(values(second.received), ['late', 'after']);
			if (qos === 2)
				assert.strictEqual(delivery(second.received, 'late').messageId, sent.messageId, 'under its packet id');
			await end(second);
		});
	}
});
