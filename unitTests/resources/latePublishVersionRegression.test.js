// Cases from HarperFast/harper#4360.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { getAuditFloor } = require('#src/resources/auditStore');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
// LMDB keys a record's log by local time, so its newest message is the last to arrive, and startTime is a local
// time too
const onRocksDB = isLMDB ? it.skip : it;

describe('A publish older than its record', function () {
	this.timeout(20000);
	let Topics, peerA, peerB;
	// each case gets its own span of origin log keys (a key is one origin transaction), above the new database's
	// audit floor, which an out-of-order write below would lose to without reconciling
	let caseBase;
	let T0;
	const at = (offset) => T0 + offset;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Topics = table({
			table: 'LatePublishes',
			database: 'latePublishVersionRegression',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'n' }],
			audit: true,
		});
		// on a version tie the later node name wins, so peer B beats peer A
		peerA = getIdOfRemoteNode('late-publish-peer-a', Topics.auditStore);
		peerB = getIdOfRemoteNode('late-publish-peer-b', Topics.auditStore);
		const floor = getAuditFloor(Topics.auditStore);
		caseBase = Number.isFinite(floor) ? Math.max(floor, Date.now()) : Date.now();
	});
	beforeEach(() => {
		T0 = caseBase += 100_000;
	});

	// one origin transaction at log key `key` (its version unless given), applied the way replication applies it
	function apply(key, nodeId, writes) {
		const context = { source: {}, sourceApply: true, timestamp: key };
		return transaction(context, async () => {
			for (const write of writes) {
				const resource = await Topics.getResource(write.id, context);
				const options = { isNotification: true, nodeId, version: write.version ?? key };
				if (write.message) resource._writePublish(write.id, write.message, options);
				else if (write.remove) await resource._writeDelete(write.id, options);
				else await resource._writeUpdate(write.id, write.record, write.fullUpdate ?? true, options);
			}
		});
	}
	const put = (id, name, version, nodeId = peerA) => apply(version, nodeId, [{ id, record: { id, name } }]);
	const patch = (id, name, version, nodeId = peerA) =>
		apply(version, nodeId, [{ id, record: { name }, fullUpdate: false }]);
	const publish = (id, n, version, nodeId = peerA) => apply(version, nodeId, [{ id, message: { n } }]);

	function recordState(id) {
		const entry = Topics.primaryStore.getEntry(id);
		return { name: entry?.value?.name, version: entry?.version - T0 };
	}
	const messagesOf = (events) => events.filter((event) => event.type === 'message').map((event) => event.value.n);
	const sorted = (values) => values.sort((a, b) => a - b);

	async function backfill(id, request) {
		const events = [];
		const subscription = await Topics.subscribe({ id, omitCurrent: true, ...request });
		subscription.on('data', (event) => events.push(event));
		try {
			// a subscription sends its backfill before any live event, so this one marks its end
			await publish(id, 'end', at(90_000));
			await waitFor(() => events.some((event) => event.value?.n === 'end'), { timeout: 5000 });
		} finally {
			subscription.end();
		}
		return messagesOf(events).filter((n) => n !== 'end');
	}

	describe('the record value', () => {
		it('keeps the newer put when a late put arrives (control, no publish)', async () => {
			await put('c1', 'B', at(200));
			await put('c1', 'C', at(170));
			assert.deepEqual(recordState('c1'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when a late publish and then a late put arrive', async () => {
			await put('d1', 'B', at(200));
			await publish('d1', 1, at(150));
			await put('d1', 'C', at(170));
			assert.deepEqual(recordState('d1'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when a late put arrives before a late publish', async () => {
			await put('d2', 'B', at(200));
			await put('d2', 'C', at(170));
			await publish('d2', 1, at(150));
			await put('d2', 'D', at(160));
			assert.deepEqual(recordState('d2'), { name: 'B', version: 200 });
		});

		it('keeps the newer put when a late put ties the late publish’s version', async () => {
			await put('d3', 'B', at(200));
			await publish('d3', 1, at(150));
			await put('d3', 'C', at(150), peerB);
			assert.deepEqual(recordState('d3'), { name: 'B', version: 200 });
		});

		it('keeps a put from a peer whose clock is ahead when this node publishes locally', async () => {
			const ahead = Date.now() + 60_000;
			await put('d4', 'B', ahead);
			await Topics.publish('d4', { n: 1 });
			await put('d4', 'C', ahead - 30_000, peerB);
			const entry = Topics.primaryStore.getEntry('d4');
			assert.deepEqual({ name: entry.value.name, behindPeer: ahead - entry.version }, { name: 'B', behindPeer: 0 });
		});

		it('keeps the record when a delete older than it arrives after a late publish (#3637)', async () => {
			await put('d5', 'B', at(200));
			await publish('d5', 1, at(150));
			await apply(at(170), peerA, [{ id: 'd5', remove: true }]);
			assert.deepEqual(recordState('d5'), { name: 'B', version: 200 });
		});

		it('applies a late put older than an in-order publish but newer than the record’s last write', async () => {
			await put('f1', 'B', at(200));
			await publish('f1', 1, at(300));
			await put('f1', 'C', at(250), peerB);
			// the put's origin applied C at 250 and then the publish at 300, so it holds C
			assert.equal(recordState('f1').name, 'C');
			// an LMDB merge stores the merged write's own, older version (#3388)
			if (!isLMDB) assert.equal(recordState('f1').version, 300);
		});

		it('applies a late patch older than an in-order publish but newer than the record’s last write', async () => {
			await put('f2', 'B', at(200));
			await publish('f2', 1, at(300));
			await patch('f2', 'P', at(250), peerB);
			assert.equal(recordState('f2').name, 'P');
			if (!isLMDB) assert.equal(recordState('f2').version, 300);
		});
	});

	describe('the record version and reads that start from it', () => {
		it('keeps the record version at its latest write after a late publish', async () => {
			await put('v1', 'B', at(200));
			await publish('v1', 1, at(150));
			assert.equal((await Topics.get('v1')).name, 'B');
			assert.equal(recordState('v1').version, 200);
		});

		async function topicWithLateMessage(id) {
			await publish(id, 1, at(100));
			await publish(id, 3, at(300));
			await publish(id, 2, at(200));
		}

		it('lists every message of a topic in its history after a late publish', async () => {
			await topicWithLateMessage('h1');
			assert.deepEqual(sorted(messagesOf(await Topics.getHistoryOfRecord('h1'))), [1, 2, 3]);
		});

		it('lists the put a late publish landed on in the record’s history', async () => {
			await put('h2', 'B', at(200));
			await publish('h2', 1, at(150));
			assert.deepEqual((await Topics.getHistoryOfRecord('h2')).map((entry) => entry.type).sort(), ['message', 'put']);
		});

		onRocksDB('lists a late message whose log key is far from the newer writes around it', async () => {
			await publish('h3', 1, at(1_000));
			await publish('h3', 3, at(20_000));
			await publish('h3', 2, at(10_000));
			await publish('h3', 4, at(30_000));
			assert.deepEqual(messagesOf(await Topics.getHistoryOfRecord('h3')), [1, 2, 3, 4]);
		});

		onRocksDB('backfills the newest message for previousCount: 1 after a late publish', async () => {
			await topicWithLateMessage('s1');
			assert.deepEqual(await backfill('s1', { previousCount: 1 }), [3]);
		});

		it('backfills every message for previousCount: 3 after a late publish', async () => {
			await topicWithLateMessage('s2');
			assert.deepEqual(sorted(await backfill('s2', { previousCount: 3 })), [1, 2, 3]);
		});

		onRocksDB('backfills a message newer than startTime after a late publish', async () => {
			await topicWithLateMessage('s3');
			assert.deepEqual(await backfill('s3', { startTime: at(250) }), [3]);
		});

		onRocksDB('backfills a late message after newer writes replaced the record’s refs, in version order', async () => {
			await publish('s4', 1, at(1_000));
			await publish('s4', 3, at(20_000));
			await publish('s4', 2, at(10_000));
			await publish('s4', 4, at(30_000));
			await put('s4', 'B', at(40_000));
			assert.deepEqual(await backfill('s4', { startTime: at(0) }), [1, 2, 3, 4]);
		});

		onRocksDB('backfills every late message of a burst longer than a record holds refs for', async () => {
			await publish('s5', 0, at(50_000));
			for (let n = 1; n <= 30; n++) await publish('s5', n, at(n * 1_000));
			await publish('s5', 31, at(60_000));
			const expected = Array.from({ length: 32 }, (_, n) => n);
			assert.deepEqual(sorted(messagesOf(await Topics.getHistoryOfRecord('s5'))), expected);
			assert.deepEqual(sorted(await backfill('s5', { startTime: at(0) })), expected);
		});

		onRocksDB('backfills two late messages to one topic from one origin transaction', async () => {
			await publish('s6', 3, at(30_000));
			await apply(at(20_000), peerA, [
				{ id: 's6', message: { n: 1 } },
				{ id: 's6', message: { n: 2 } },
			]);
			assert.deepEqual(sorted(await backfill('s6', { startTime: at(0) })), [1, 2, 3]);
		});

		onRocksDB('backfills a late message whose log key is above startTime while its record’s is not', async () => {
			await publish('s7', 3, at(30_000));
			await apply(at(40_000), peerB, [{ id: 's7', message: { n: 2 }, version: at(20_000) }]);
			assert.equal(recordState('s7').version, 30_000);
			assert.deepEqual(await backfill('s7', { startTime: at(35_000) }), [2]);
		});

		onRocksDB('backfills a late message from a transaction that also writes thousands of other records', async () => {
			await publish('s9', 2, at(30_000));
			const writes = Array.from({ length: 3_000 }, (_, n) => ({ id: `other-${n}`, record: { id: `other-${n}` } }));
			writes.push({ id: 's9', message: { n: 1 } });
			await apply(at(20_000), peerB, writes);
			assert.deepEqual(sorted(await backfill('s9', { startTime: at(0) })), [1, 2]);
		});

		onRocksDB('follows refs only to late writes when every log key differs from its version', async () => {
			for (let n = 1; n <= 20; n++)
				await apply(at(n * 1_000 + 7), peerA, [{ id: 's8', message: { n }, version: at(n * 1_000) }]);
			await apply(at(30_000), peerB, [{ id: 's8', message: { n: 0 }, version: at(500) }]);
			const { getRange } = Topics.auditStore;
			let refReads = 0;
			Topics.auditStore.getRange = function (options) {
				if (options?.exactStart && options.readUncommitted && options.log !== undefined) refReads++;
				return getRange.call(this, options);
			};
			let newest;
			try {
				newest = await backfill('s8', { previousCount: 1 });
			} finally {
				Topics.auditStore.getRange = getRange;
			}
			assert.deepEqual(newest, [20]);
			assert.ok(refReads <= 6, `${refReads} log reads for the newest of 20 messages`);
		});

		onRocksDB('reaches a late message through the refs of the writes after it', async () => {
			await topicWithLateMessage('p1');
			const head = Topics.primaryStore.getEntry('p1');
			assert.equal(head.version - T0, 300);
			const late = head.additionalAuditRefs.map((ref) =>
				Topics.auditStore.getSync(ref.version, Topics.tableId, 'p1', ref.nodeId, true)
			);
			assert.deepEqual(
				late.map((entry) => entry?.version - T0),
				[200]
			);
		});
	});
});
