const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getDatabaseGeneration, persistOriginClosedFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { LOG_CURSORS } = require('#src/resources/subscriptionCheckpoint');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
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

const SEQ = Symbol.for('seq');
/** The peer's direct route here certifies everything it wrote below `closedFloor`; `via` adds a relayed route too. */
function certifyRoute(T, peerName, closedFloor, via) {
	const nodeId = getIdOfRemoteNode(peerName, T.auditStore);
	const node = {
		id: nodeId,
		closedFloor,
		originGeneration: `${peerName}-generation`,
		fullCoverage: true,
		certifiedFrom: 0,
	};
	T.dbisDB.putSync([SEQ, nodeId], { seqId: 1, nodes: [node] });
	if (via) T.dbisDB.putSync([SEQ, getIdOfRemoteNode(via, T.auditStore)], { seqId: 1, nodes: [node] });
	return nodeId;
}

function certifyOwn(T) {
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

/** Waits until the saved entry carries a checkpoint at or past a floor certified now. */
async function storedCheckpoint(T, session, clientId) {
	await sleep(2);
	const floor = certifyOwn(T);
	let record;
	await waitFor(async () => {
		record = await save(session, clientId);
		const checkpoint = record?.subscriptions?.[0]?.checkpoint;
		return checkpoint !== undefined && checkpoint.time >= floor;
	}, 10_000);
	return record;
}

/**
 * Rewrites the record as another node would have saved it: bound to another database generation, with its whole
 * vector of log positions, that node vouching for this node's own log.
 */
async function asSavedElsewhere(T, record, database) {
	const thisNode = getThisNodeName();
	const shared = record.cursors[database];
	const subscriptions = record.subscriptions.map((entry) => {
		const logs = new Map(
			shared.logs.map(([origin, readThrough, generation]) => [origin, [origin, readThrough, readThrough, generation]])
		);
		for (const held of entry.cursors) logs.set(held[0], held);
		const own = logs.get(thisNode);
		own[3] = getDatabaseGeneration(T.auditStore).id;
		return {
			...entry,
			databaseGeneration: 'another-generation',
			cursors: {
				generation: 'another-generation',
				node: 'elsewhere',
				logs: [...logs.values()].map((log) => log.filter((part) => part !== undefined)),
			},
		};
	});
	await databases.system.hdb_durable_session.put({ id: record.id, subscriptions });
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
		setOriginCaptureIntervalForTests(100);
	});
	after(() => setOriginCaptureIntervalForTests());

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

	it('delivers a late entry on either side of a cursor an unacknowledged delivery holds', async () => {
		const { T, clientId, peer, peerKey, first } = await savedSession(1, { disconnect: false });
		// read in this order: `held` is never acknowledged, so the peer's cursor stays before it
		await applyFromOrigin(T, peer, peerKey + 20, 'held');
		await applyFromOrigin(T, peer, peerKey + 10, 'late-and-taken');
		await waitFor(() => values(first.received).includes('late-and-taken'));
		await first.session.acknowledge(delivery(first.received, 'late-and-taken').messageId);
		await end(first);
		const record = await stored(clientId);
		const [origin, cursor, readThrough] = record.subscriptions[0].cursors[0];
		assert.deepStrictEqual(
			[cursor, readThrough],
			[peerKey, peerKey + 10],
			`${origin} is held before the unacknowledged one`
		);
		// after the save, another late one lands behind what the session had read
		await applyFromOrigin(T, peer, peerKey + 5, 'late-after-save');
		const second = await resumed(T, clientId);
		assert.deepStrictEqual(values(second.received), ['held', 'late-after-save', 'after']);
		await end(second);
	});

	it('reads a log created after the save from its start', async () => {
		const { T, name, clientId, lateKey } = await savedSession(1);
		const joined = getIdOfRemoteNode(`joined-${name}`, T.auditStore);
		await applyFromOrigin(T, joined, lateKey, 'from-a-new-node');
		const second = await resumed(T, clientId);
		assert.deepStrictEqual(values(second.received), ['from-a-new-node', 'after']);
		await end(second);
	});

	it("anchors a log it has read nothing from at the log's end when the topic is subscribed", async () => {
		const { T, name } = topicTable();
		const clientId = `anchor-${name}`;
		const peerName = `peer-${name}`;
		const peer = getIdOfRemoteNode(peerName, T.auditStore);
		const before = Date.now();
		await applyFromOrigin(T, peer, before + 50, 'before-highest');
		// the log's last entry is not the one with its highest key
		await applyFromOrigin(T, peer, before + 40, 'before-late');
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		const record = await stored(clientId);
		assert.strictEqual(new Map(record.cursors[`cursor_${name}`].logs).get(peerName), before + 40);
		await end(first);
		await applyFromOrigin(T, peer, before + 30, 'late');
		const second = await resumed(T, clientId);
		assert.deepStrictEqual(values(second.received), ['late', 'after'], 'nothing from before the SUBSCRIBE');
		await end(second);
	});

	it('keeps a topic that holds a log back apart from the read-through its database shares', async () => {
		const { T, name } = topicTable();
		const database = `cursor_${name}`;
		const { T: Other, name: otherName } = topicTable(database);
		const clientId = `siblings-${name}`;
		const peer = getIdOfRemoteNode(`peer-${name}`, T.auditStore);
		const first = await connect(clientId);
		await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
		await first.session.addSubscription({ topic: `${otherName}/#`, qos: 1, rh: 2 }, true);
		const peerKey = Date.now();
		await applyFromOrigin(T, peer, peerKey, 'held');
		await applyFromOrigin(Other, peer, peerKey + 1, 'taken');
		await waitFor(() => values(first.received).includes('taken') && values(first.received).includes('held'));
		await first.session.acknowledge(delivery(first.received, 'taken').messageId);
		await end(first);
		const record = await stored(clientId);
		const entries = new Map(record.subscriptions.map((entry) => [entry.topic, entry]));
		assert.strictEqual(new Map(record.cursors[database].logs).get(`peer-${name}`), peerKey + 1);
		assert.deepStrictEqual(
			entries.get(`${name}/#`).cursors,
			[[`peer-${name}`, 0, peerKey + 1]],
			'held before its delivery'
		);
		assert.deepStrictEqual(entries.get(`${otherName}/#`).cursors, []);
		const second = await resumed(T, clientId);
		assert.deepStrictEqual(values(second.received), ['held', 'after'], 'the other topic is sent nothing again');
		await end(second);
	});

	it('a replacing SUBSCRIBE sends a late delivery the replaced subscription left unacknowledged', async () => {
		const { T, topic, clientId, peer, lateKey, first } = await savedSession(1, { disconnect: false });
		const requests = resumeRequests(first.session);
		await applyFromOrigin(T, peer, lateKey, 'late');
		await waitFor(() => values(first.received).includes('late'));
		assert.ok(first.session.topics.get(topic).entry.startTime > lateKey, 'it arrived below the position');
		await first.session.addSubscription({ topic, qos: 1, rh: 2 }, true);
		assert.ok(requests.at(-1)[LOG_CURSORS].logs instanceof Map, 'continued from its log positions');
		assert.ok(requests.at(-1).startTime < lateKey, 'and from below the delivery not yet taken');
		await waitFor(() => values(first.received).filter((value) => value === 'late').length === 2);
		await end(first);
	});

	it('resumes a record saved without log positions, or with ones it cannot read, from its position alone', async () => {
		for (const cursors of [undefined, { generation: 1 }, [['peer', 'not-a-key', 2]]]) {
			const { T, clientId, peer, lateKey, record } = await savedSession(1);
			const subscriptions = record.subscriptions.map((entry) => ({ ...entry, cursors }));
			await databases.system.hdb_durable_session.put({ id: clientId, subscriptions, cursors: record.cursors });
			await applyFromOrigin(T, peer, lateKey, 'late');
			const second = await resumed(T, clientId);
			assert.strictEqual(second.requests[0][LOG_CURSORS], true);
			assert.deepStrictEqual(values(second.received), ['after'], 'as before: nothing below the position');
			assert.deepStrictEqual(second.closed, []);
			await take(second.session, second.received, 1);
			await end(second);
			assert.deepStrictEqual((await stored(clientId)).subscriptions[0].cursors, [], 'and saves them from then on');
		}
	});

	describe('on a node the session moved to', () => {
		/**
		 * A QoS 1 session with a checkpoint, a peer whose route here is certified, `taken` delivered from the peer and
		 * acknowledged, and its record rewritten as another node's. Receipts at or below the position are written
		 * only by a final save, so the record of a session that did not end cleanly has none for `taken`.
		 */
		async function movedSession({ via } = {}) {
			const { T, name } = topicTable();
			await T.put('seed', { value: 0 });
			const clientId = `moved-${name}`;
			const peerName = `peer-${name}`;
			const first = await connect(clientId);
			await first.session.addSubscription({ topic: `${name}/#`, qos: 1, rh: 2 }, true);
			await sleep(5);
			const peerFloor = Date.now();
			const peer = certifyRoute(T, peerName, peerFloor, via);
			// the first checkpoint is adopted only while nothing above its floor lacks a receipt
			await storedCheckpoint(T, first.session, clientId);
			await applyFromOrigin(T, peer, peerFloor + 1, 'taken');
			await waitFor(() => values(first.received).includes('taken'));
			await sleep(5);
			await T.put('local', { value: 'local' });
			await waitFor(() => values(first.received).includes('local'));
			await take(first.session, first.received, 1);
			let record;
			await waitFor(async () => {
				record = await storedCheckpoint(T, first.session, clientId);
				return record.subscriptions[0].startTime > peerFloor + 1;
			}, 10_000);
			return { T, name, clientId, peer, peerName, peerFloor, first, record, database: `cursor_${name}` };
		}

		it('records the generation of an origin whose only route here is its certified direct one', async () => {
			const { peerName, record, database, first } = await movedSession();
			const logs = new Map(record.cursors[database].logs.map(([origin, , generation]) => [origin, generation]));
			assert.strictEqual(logs.get(peerName), `${peerName}-generation`);
			assert.strictEqual(logs.get(getThisNodeName()), undefined, 'its own log needs none');
			await end(first);
		});

		it('records none for an origin that also arrives through another node', async () => {
			const { peerName, record, database, first } = await movedSession({ via: 'relay' });
			assert.strictEqual(
				new Map(record.cursors[database].logs.map(([origin, , g]) => [origin, g])).get(peerName),
				undefined
			);
			await end(first);
		});

		it('reads an origin both nodes vouch for after its saved position, not from its checkpoint boundary', async () => {
			const { T, clientId, record, database, first } = await movedSession();
			first.session.supersede();
			await asSavedElsewhere(T, record, database);
			const second = await resumed(T, clientId);
			assert.ok(second.requests[0].resume, 'resumed from the checkpoint');
			assert.strictEqual(second.requests[0][LOG_CURSORS].node, 'elsewhere');
			assert.deepStrictEqual(
				values(second.received),
				['after'],
				'what was taken before the position is not read again'
			);
			assert.deepStrictEqual(second.closed, []);
			await end(second);
		});

		it('reads an origin this node does not vouch for from its checkpoint boundary, as before', async () => {
			const { T, clientId, peerName, peerFloor, record, database, first } = await movedSession();
			first.session.supersede();
			await asSavedElsewhere(T, record, database);
			certifyRoute(T, peerName, peerFloor, 'relay');
			const second = await resumed(T, clientId);
			assert.deepStrictEqual(values(second.received).sort(), ['after', 'taken'], 'the boundary replay sends it again');
			assert.deepStrictEqual(second.closed, []);
			await end(second);
		});

		it('falls back to the checkpoint boundary, with no reset, when a saved position is not in the log here', async () => {
			const { T, clientId, peerName, record, database, first } = await movedSession();
			first.session.supersede();
			const shared = record.cursors[database];
			const logs = shared.logs.map((log) => (log[0] === peerName ? [log[0], log[1] + 0.5, log[2]] : log));
			await asSavedElsewhere(T, { ...record, cursors: { [database]: { ...shared, logs } } }, database);
			const second = await resumed(T, clientId);
			assert.deepStrictEqual(values(second.received).sort(), ['after', 'taken']);
			assert.deepStrictEqual(second.closed, []);
			await end(second);
		});

		it('an older copy of the record sends again what was taken since, and skips nothing', async () => {
			const { T, clientId, peer, peerFloor, record: older, database, first } = await movedSession();
			await applyFromOrigin(T, peer, peerFloor + 2, 'taken-later');
			await T.put('local-later', { value: 'local-later' });
			await waitFor(
				() => values(first.received).includes('local-later') && values(first.received).includes('taken-later')
			);
			await take(first.session, first.received.slice(2), 1);
			await storedCheckpoint(T, first.session, clientId);
			first.session.supersede();
			await asSavedElsewhere(T, older, database);
			const second = await resumed(T, clientId);
			assert.deepStrictEqual(values(second.received).sort(), ['after', 'local-later', 'taken-later']);
			await end(second);
		});
	});
});
