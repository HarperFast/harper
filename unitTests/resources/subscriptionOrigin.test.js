const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { getThisNodeName } = require('#src/server/nodeName');
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const REMOTE_NODE_IDS = Symbol.for('remote-ids');
// Collection previousCount replay is LMDB-only today: its reverse scan starts at 'z', which the
// RocksDB transaction log rejects (see subscriptionPreviousCountScanBound.test.js).
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Subscription origin identity', () => {
	let T;
	let sequence = 0;
	const subscriptions = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	beforeEach(() => {
		T = table({
			database: 'test',
			table: `Origin${++sequence}`,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
	});
	afterEach(() => {
		for (const subscription of subscriptions.splice(0)) subscription.end();
	});

	async function subscribe(options, Table = T) {
		const events = [];
		let replayEnd = 0;
		if (options.startTime && options.id === undefined) {
			for (const record of Table.auditStore.getRange({ start: options.startTime })) {
				if (record.tableId === Table.tableId) replayEnd = Math.max(replayEnd, record.txnLogKey);
			}
		}
		const subscription = await Table.subscribe({ ...options, listener: (event) => events.push(event) });
		subscriptions.push(subscription);
		if (replayEnd) await waitFor(() => subscription.closed || subscription.startTime >= replayEnd);
		return { subscription, events };
	}

	/** Writes arrive through the replication sink, so their audit entries carry the peer's id. */
	function peerSource(Table, peerName) {
		const nodeId = peerName === undefined ? 4242 : getIdOfRemoteNode(peerName, Table.auditStore);
		const source = new IterableEventQueue();
		Table.sourcedFrom({ subscribe: () => source, subscribeOnThisThread: () => true }, { intermediateSource: true });
		return {
			nodeId,
			put(id, value) {
				source.send({ type: 'put', id, value: { id, value }, nodeId, timestamp: Date.now() });
				return waitFor(async () => (await Table.get(id))?.value === value);
			},
		};
	}

	function originFields(event) {
		return { nodeId: event.nodeId, nodeName: event.nodeName };
	}

	it('adds no key without includeOrigin', async () => {
		await T.put('A', { value: 1 });
		const replay = await subscribe({ startTime: 1 });
		const live = await subscribe({ omitCurrent: true });
		await T.put('A', { value: 2 });
		await waitFor(() => live.events.length >= 1);
		const single = await subscribe({ id: 'A', startTime: 1 });
		for (const event of [...replay.events, ...live.events]) {
			assert.deepStrictEqual(Object.keys(event).sort(), [
				'beginTxn',
				'id',
				'localTime',
				'size',
				'type',
				'value',
				'version',
			]);
		}
		assert.ok(single.events.length >= 1);
		for (const event of single.events) assert.ok(!('nodeName' in event));
	});

	it('names this node on live delivery, replay, previousCount and single-record history', async () => {
		await T.put('A', { value: 1 });
		const replay = await subscribe({ startTime: 1, includeOrigin: true });
		const previous = isLMDB ? await subscribe({ previousCount: 1, includeOrigin: true }) : undefined;
		const single = await subscribe({ id: 'A', startTime: 1, includeOrigin: true });
		const live = await subscribe({ includeOrigin: true, omitCurrent: true });
		await T.put('A', { value: 2 });
		await waitFor(() => live.events.length >= 1);
		const expected = { nodeId: 0, nodeName: getThisNodeName() };
		for (const [label, { events }] of Object.entries({ replay, single, live, ...(previous && { previous }) })) {
			assert.ok(events.length >= 1, `${label} delivered nothing`);
			for (const event of events) {
				assert.deepStrictEqual(
					originFields(event),
					expected,
					`${label}: ${event instanceof Error ? event.stack : JSON.stringify(event)}`
				);
			}
		}
	});

	it('names the origin of published messages', async () => {
		const { events } = await subscribe({ includeOrigin: true });
		await T.publish('topic', { value: 1 });
		await waitFor(() => events.length >= 1);
		assert.equal(events[0].type, 'message');
		assert.deepStrictEqual(originFields(events[0]), { nodeId: 0, nodeName: getThisNodeName() });
	});

	it('leaves end_txn and the current-value send without origin', async () => {
		await T.put('A', { value: 1 });
		const current = await subscribe({ id: 'A', includeOrigin: true });
		assert.equal(current.events.length, 1);
		assert.equal(current.events[0].type, 'put');
		assert.ok(!('nodeName' in current.events[0]));
		const { events } = await subscribe({ includeOrigin: true, supportsTransactions: true, omitCurrent: true });
		await T.put('A', { value: 2 });
		await waitFor(() => events.some((event) => event.type === 'end_txn'));
		const endTxn = events.find((event) => event.type === 'end_txn');
		assert.ok(!('nodeId' in endTxn) && !('nodeName' in endTxn));
		assert.deepStrictEqual(originFields(events.find((event) => event.type === 'put')), {
			nodeId: 0,
			nodeName: getThisNodeName(),
		});
	});

	it('names a peer origin by its stable name, live and on replay', async () => {
		const peer = peerSource(T, 'peer-a');
		const live = await subscribe({ includeOrigin: true });
		await peer.put('P', 1);
		await waitFor(() => live.events.length >= 1);
		assert.notEqual(peer.nodeId, 0);
		assert.deepStrictEqual(originFields(live.events[0]), { nodeId: peer.nodeId, nodeName: 'peer-a' });
		const replay = await subscribe({ startTime: 1, includeOrigin: true });
		assert.deepStrictEqual(originFields(replay.events[0]), { nodeId: peer.nodeId, nodeName: 'peer-a' });
		await T.put('L', { value: 1 });
		await waitFor(() => live.events.length >= 2);
		assert.deepStrictEqual(originFields(live.events[1]), { nodeId: 0, nodeName: getThisNodeName() });
	});

	function assertFailedClosed({ subscription, events }) {
		assert.ok(subscription.closed);
		assert.equal(events.length, 1, 'only the final error reaches the listener');
		assert.equal(events[0].code, 'SUBSCRIPTION_ORIGIN_UNRESOLVED');
		assert.equal(events[0].name, 'SubscriptionOriginError');
		assert.equal(events[0].statusCode, 500);
	}

	it('fails the subscription instead of delivering an event whose origin is not in the node map', async () => {
		const peer = peerSource(T);
		await peer.put('U', 1);
		const replay = await subscribe({ startTime: 1, includeOrigin: true });
		await waitFor(() => replay.subscription.closed);
		assertFailedClosed(replay);
		const live = await subscribe({ includeOrigin: true, omitCurrent: true });
		await peer.put('V', 1);
		await waitFor(() => live.subscription.closed);
		assertFailedClosed(live);
		const indifferent = await subscribe({ startTime: 1 });
		assert.equal(indifferent.events.length, 2, 'a subscription without includeOrigin still gets both writes');
	});

	it('fails the subscription when the node map cannot be read', async () => {
		// Own database: the corrupt map record below breaks every later write to it.
		const Corrupt = table({
			database: 'origin-corrupt-map',
			table: 'Corrupt',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		await Corrupt.put('A', { value: 1 });
		Corrupt.auditStore.putSync(REMOTE_NODE_IDS, Buffer.from([0x92]));
		const replay = await subscribe({ startTime: 1, includeOrigin: true }, Corrupt);
		await waitFor(() => replay.subscription.closed);
		assertFailedClosed(replay);
		assert.ok(replay.events[0].cause instanceof Error, 'the map read failure rides along as the cause');
	});
});
