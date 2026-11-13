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
const engine = isLMDB ? 'lmdb' : 'rocksdb';
const RUN_KNOWN_FAILURES = Boolean(process.env.RUN_KNOWN_FAILURES);

// Green only while the pinned wrong result holds; RUN_KNOWN_FAILURES=1 asserts the expected one instead.
function failsUntilFixed(title, observe, { expected, observed, engines = ['rocksdb', 'lmdb'] }) {
	if (RUN_KNOWN_FAILURES || !engines.includes(engine))
		return it(title, async () => assert.deepEqual(await observe(), expected));
	it(`${title} (known failure)`, async () => {
		assert.deepEqual(
			await observe(),
			observed,
			`no longer the known wrong result; if it is now ${JSON.stringify(expected)}, make this a plain test`
		);
	});
}

describe('A publish restamping its record', function () {
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
		T0 = caseBase += 1000;
	});

	function apply(version, nodeId, write) {
		const context = { source: {}, sourceApply: true, timestamp: version };
		return transaction(context, async () => {
			const resource = await Topics.getResource(write.id, context);
			const options = { isNotification: true, nodeId, version };
			if (write.message) return resource._writePublish(write.id, write.message, options);
			return resource._writeUpdate(write.id, write.record, write.fullUpdate ?? true, options);
		});
	}
	const put = (id, name, version, nodeId = peerA) => apply(version, nodeId, { id, record: { id, name } });
	const patch = (id, name, version, nodeId = peerA) =>
		apply(version, nodeId, { id, record: { name }, fullUpdate: false });
	const publish = (id, n, version, nodeId = peerA) => apply(version, nodeId, { id, message: { n } });

	function recordState(id) {
		const entry = Topics.primaryStore.getEntry(id);
		return { name: entry?.value?.name, version: entry?.version - T0 };
	}
	const messagesOf = (events) => events.filter((event) => event.type === 'message').map((event) => event.value.n);

	async function backfill(id, request) {
		const events = [];
		const subscription = await Topics.subscribe({ id, omitCurrent: true, ...request });
		subscription.on('data', (event) => events.push(event));
		try {
			// a subscription sends its backfill before any live event, so this one marks its end
			await publish(id, 'end', at(500));
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

		failsUntilFixed(
			'keeps the newer put when a late publish and then a late put arrive',
			async () => {
				await put('d1', 'B', at(200));
				await publish('d1', 1, at(150));
				await put('d1', 'C', at(170));
				return recordState('d1');
			},
			{ expected: { name: 'B', version: 200 }, observed: { name: 'C', version: 170 } }
		);

		failsUntilFixed(
			'keeps the newer put when a late put arrives before a late publish',
			async () => {
				await put('d2', 'B', at(200));
				await put('d2', 'C', at(170));
				await publish('d2', 1, at(150));
				await put('d2', 'D', at(160));
				return recordState('d2');
			},
			{ expected: { name: 'B', version: 200 }, observed: { name: 'D', version: 160 } }
		);

		failsUntilFixed(
			'keeps the newer put when a late put ties the late publish’s version',
			async () => {
				await put('d3', 'B', at(200));
				await publish('d3', 1, at(150));
				await put('d3', 'C', at(150), peerB);
				return recordState('d3');
			},
			{ expected: { name: 'B', version: 200 }, observed: { name: 'C', version: 150 } }
		);

		failsUntilFixed(
			'keeps a put from a peer whose clock is ahead when this node publishes locally',
			async () => {
				const ahead = Date.now() + 60_000;
				await put('d4', 'B', ahead);
				await Topics.publish('d4', { n: 1 });
				await put('d4', 'C', ahead - 30_000, peerB);
				const entry = Topics.primaryStore.getEntry('d4');
				return { name: entry.value.name, behindPeer: ahead - entry.version };
			},
			{ expected: { name: 'B', behindPeer: 0 }, observed: { name: 'C', behindPeer: 30_000 } }
		);

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
		failsUntilFixed(
			'keeps the record version at its latest write after a late publish',
			async () => {
				await put('v1', 'B', at(200));
				await publish('v1', 1, at(150));
				assert.equal((await Topics.get('v1')).name, 'B');
				return recordState('v1').version;
			},
			{ expected: 200, observed: 150 }
		);

		async function topicWithLateMessage(id) {
			await publish(id, 1, at(100));
			await publish(id, 3, at(300));
			await publish(id, 2, at(200));
		}

		failsUntilFixed(
			'lists every message of a topic in its history after a late publish',
			async () => {
				await topicWithLateMessage('h1');
				return messagesOf(await Topics.getHistoryOfRecord('h1')).sort();
			},
			{ expected: [1, 2, 3], observed: [1, 2], engines: ['rocksdb'] }
		);

		failsUntilFixed(
			'lists the put a late publish landed on in the record’s history',
			async () => {
				await put('h2', 'B', at(200));
				await publish('h2', 1, at(150));
				return (await Topics.getHistoryOfRecord('h2')).map((entry) => entry.type).sort();
			},
			{ expected: ['message', 'put'], observed: ['message'], engines: ['rocksdb'] }
		);

		// LMDB keys a record's log by local time, so its newest message is the last to arrive, and startTime is a
		// local time too
		const onRocksDB = isLMDB ? (title) => it.skip(title) : failsUntilFixed;

		onRocksDB(
			'backfills the newest message for previousCount: 1 after a late publish',
			async () => {
				await topicWithLateMessage('s1');
				return backfill('s1', { previousCount: 1 });
			},
			{ expected: [3], observed: [2] }
		);

		it('backfills every message for previousCount: 3 after a late publish', async () => {
			await topicWithLateMessage('s2');
			assert.deepEqual((await backfill('s2', { previousCount: 3 })).sort(), [1, 2, 3]);
		});

		onRocksDB(
			'backfills a message newer than startTime after a late publish',
			async () => {
				await topicWithLateMessage('s3');
				return backfill('s3', { startTime: at(250) });
			},
			{ expected: [3], observed: [] }
		);

		it('reaches every message through previous-version references after a late publish', async function () {
			if (isLMDB) return this.skip(); // LMDB links by local time, in arrival order
			await topicWithLateMessage('p1');
			const visited = [];
			let next = Topics.primaryStore.getEntry('p1').version;
			while (next && visited.length < 10) {
				const entry = Topics.auditStore.getSync(next, Topics.tableId, 'p1', peerA, true);
				if (!entry) break;
				visited.push(entry.version - T0);
				next = entry.previousVersion;
			}
			assert.deepEqual(visited.sort(), [100, 200, 300]);
		});
	});
});
