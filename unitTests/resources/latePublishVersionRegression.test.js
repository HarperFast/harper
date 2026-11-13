// A replicated publish restamps the record it lands on with its own version, even when that version is below the
// record's: a late publish moves the record version backward. The failsUntilFixed cases reproduce what that breaks;
// the it() cases pin what a fix that only restamps forward must keep.
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

// Passes while its assertion fails, so CI stays green, and fails once it passes, so the fix turns it into it().
// On an engine outside `engines` it is a plain test: there the behavior is already right. RUN_KNOWN_FAILURES=1
// runs every case as a plain test to show the failures.
function failsUntilFixed(title, test, { engines = ['rocksdb', 'lmdb'] } = {}) {
	if (RUN_KNOWN_FAILURES || !engines.includes(engine)) return it(title, test);
	it(`${title} (known failure)`, async function () {
		try {
			await test.call(this);
		} catch (error) {
			if (error instanceof assert.AssertionError) return;
			throw error;
		}
		assert.fail('this now passes: change failsUntilFixed to it()');
	});
}

describe('A replicated publish restamping its record', function () {
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
			// a live publish is delivered after the backfill
			await publish(id, 'end', at(500));
			await waitFor(() => events.some((event) => event.value?.n === 'end'), { timeout: 5000 });
		} finally {
			subscription.end();
		}
		return messagesOf(events).filter((n) => n !== 'end');
	}

	describe('the record value on the receiving node', () => {
		it('keeps the newer put when a late put arrives (control, no publish)', async () => {
			await put('c1', 'B', at(200));
			await put('c1', 'C', at(170));
			assert.deepEqual(recordState('c1'), { name: 'B', version: 200 });
		});

		failsUntilFixed('keeps the newer put when a late publish and then a late put arrive', async () => {
			await put('d1', 'B', at(200));
			await publish('d1', 1, at(150));
			await put('d1', 'C', at(170));
			assert.deepEqual(recordState('d1'), { name: 'B', version: 200 });
		});

		failsUntilFixed('keeps the newer put when a late put arrives before a late publish', async () => {
			await put('d2', 'B', at(200));
			await put('d2', 'C', at(170));
			await publish('d2', 1, at(150));
			await put('d2', 'D', at(160));
			assert.deepEqual(recordState('d2'), { name: 'B', version: 200 });
		});

		failsUntilFixed('keeps the newer put when a late put ties the late publish’s version', async () => {
			await put('d3', 'B', at(200));
			await publish('d3', 1, at(150));
			// peer B wins a tie at 150, but 150 is below the put at 200
			await put('d3', 'C', at(150), peerB);
			assert.deepEqual(recordState('d3'), { name: 'B', version: 200 });
		});

		failsUntilFixed('keeps a put from a peer whose clock is ahead when this node publishes locally', async () => {
			const ahead = Date.now() + 60_000;
			await put('d4', 'B', ahead);
			// the local publish is stamped with this node's clock, below the peer's put
			await Topics.publish('d4', { n: 1 });
			await put('d4', 'C', ahead - 30_000, peerB);
			assert.deepEqual(
				{ name: recordState('d4').name, version: Topics.primaryStore.getEntry('d4').version },
				{ name: 'B', version: ahead }
			);
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

	describe('the record version and what reads through it see', () => {
		failsUntilFixed('keeps the record version at its latest write after a late publish', async () => {
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

		failsUntilFixed(
			'lists every message of a topic in its history after a late publish',
			async () => {
				await topicWithLateMessage('h1');
				const history = await Topics.getHistoryOfRecord('h1');
				assert.deepEqual(messagesOf(history).sort(), [1, 2, 3]);
			},
			{ engines: ['rocksdb'] }
		);

		failsUntilFixed(
			'lists the put a late publish landed on in the record’s history',
			async () => {
				await put('h2', 'B', at(200));
				await publish('h2', 1, at(150));
				const history = await Topics.getHistoryOfRecord('h2');
				assert.deepEqual(history.map((entry) => entry.type).sort(), ['message', 'put']);
			},
			{ engines: ['rocksdb'] }
		);

		// LMDB keys a record's log by local time, so its newest message is the last to arrive, and startTime is a
		// local time too
		const onRocksDB = isLMDB ? it.skip : failsUntilFixed;

		onRocksDB('backfills the newest message for previousCount: 1 after a late publish', async () => {
			await topicWithLateMessage('s1');
			assert.deepEqual(await backfill('s1', { previousCount: 1 }), [3]);
		});

		it('backfills every message for previousCount: 3 after a late publish', async () => {
			await topicWithLateMessage('s2');
			assert.deepEqual((await backfill('s2', { previousCount: 3 })).sort(), [1, 2, 3]);
		});

		onRocksDB('backfills a message newer than startTime after a late publish', async () => {
			await topicWithLateMessage('s3');
			assert.deepEqual(await backfill('s3', { startTime: at(250) }), [3]);
		});

		it('still reaches every message through previous-version references after a late publish', async function () {
			if (isLMDB) return this.skip(); // LMDB links by local time, in arrival order
			await topicWithLateMessage('p1');
			const visited = [];
			let next = Topics.primaryStore.getEntry('p1').version;
			while (next) {
				const entry = Topics.auditStore.getSync(next, Topics.tableId, 'p1', peerA, true);
				if (!entry) break;
				visited.push(entry.version - T0);
				next = entry.previousVersion;
			}
			// today the late message is the head and links up to the newest one: 200, 300, 100
			assert.deepEqual(visited.sort(), [100, 200, 300]);
		});
	});
});
