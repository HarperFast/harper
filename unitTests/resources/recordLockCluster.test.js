const assert = require('assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { clearThisNodeName, getThisNodeName } = require('#src/server/nodeName');
const {
	registerClusterLockTransport,
	unregisterClusterLockTransport,
	decodeLockControlPayload,
} = require('#src/resources/recordLockCoordinator');
const { LOCAL_ONLY, isLockControlType } = require('#src/resources/auditStore');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Cluster record locks (harper#483 Phase 1) against a real table: what the in-memory coordinator
// suite cannot prove — that a control entry encodes, commits, decodes and stays out of every surface
// that reports record activity, and that it does not collide with the holder's own audit entry.
describe('Cluster record locks on a real table (harper#483 Phase 1)', () => {
	let ClusterLockTest;
	let previousHostname;
	let nextId = 1;
	const id = () => `cluster-lock-${nextId++}`;
	const NODE_NAME = 'lock-test-node';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		previousHostname = env.get(CONFIG_PARAMS.NODE_HOSTNAME);
		// The coordinator refuses a loopback identity, and a bare test box resolves to one.
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, NODE_NAME);
		clearThisNodeName();
		ClusterLockTest = table({
			table: 'ClusterLockTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'name' }],
		});
	});

	after(function () {
		unregisterClusterLockTransport('test', true);
		env.setProperty(CONFIG_PARAMS.NODE_HOSTNAME, previousHostname);
		clearThisNodeName();
	});

	afterEach(function () {
		unregisterClusterLockTransport('test', true);
	});

	/** Register a transport whose participant set is only this node, so a round completes at once. */
	function useSoloTransport(overrides = {}) {
		registerClusterLockTransport('test', {
			participants: () => overrides.participants ?? [{ nodeId: getThisNodeName(), capable: true }],
			ownsCoordination: () => overrides.owns ?? true,
			...overrides.extra,
		});
	}

	/** Every lock control entry currently in this table's transaction log, eagerly materialized. */
	function controlEntries() {
		const found = [];
		for (const entry of ClusterLockTest.auditStore.getRange({ start: 1 })) {
			if (entry.tableId !== ClusterLockTest.tableId || !isLockControlType(entry.type)) continue;
			found.push({
				type: entry.type,
				recordId: entry.recordId,
				version: entry.version,
				extendedType: entry.extendedType,
				value: entry.getValue(ClusterLockTest.primaryStore),
			});
		}
		return found;
	}

	describe('control entries', () => {
		it('writes a replicating request with no record id, and a release on unlock', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const before = controlEntries().length;
			const recordId = id();
			const record = await ClusterLockTest.lock(recordId, { hold: true, lease: 5000 });
			const afterLock = controlEntries().slice(before);
			assert.strictEqual(afterLock.length, 1, 'one control entry per acquisition');

			const request = afterLock[0];
			assert.strictEqual(request.type, 'lockRequest');
			assert.strictEqual(request.recordId, null, 'the locked key rides in the payload, not the record id');
			assert.strictEqual(request.extendedType & LOCAL_ONLY, 0, 'control entries must replicate');
			const decoded = decodeLockControlPayload(request.type, request.value);
			assert.ok(decoded, 'the payload decodes');
			assert.strictEqual(decoded.key, recordId);
			assert.strictEqual(decoded.requester, NODE_NAME);
			assert.strictEqual(decoded.tsR, request.version, 'ts_R is the entry’s own log timestamp');
			assert.strictEqual(decoded.leaseMs, 5000);

			await record.unlock();
			const afterUnlock = controlEntries().slice(before);
			assert.deepStrictEqual(
				afterUnlock.map((entry) => entry.type),
				['lockRequest', 'lockRelease']
			);
			assert.strictEqual(decodeLockControlPayload('lockRelease', afterUnlock[1].value).tsR, decoded.tsR);
		});

		it('does not shadow the holder’s own audit entry at the same timestamp', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await ClusterLockTest.put({ id: recordId, n: 0 });
			const before = controlEntries().length;
			const record = await ClusterLockTest.lock(recordId, { hold: true, lease: 5000 });
			record.n = 7;
			await record.save();
			await record.unlock();

			const request = controlEntries().slice(before)[0];
			// This is the lookup _writeUpdate's keyed dedup performs. A control entry carrying the locked
			// key would answer it, and the holder's write would be discarded as an already-applied
			// duplicate.
			const atRequestTime = ClusterLockTest.auditStore.get(request.version, ClusterLockTest.tableId, recordId, 0);
			assert.ok(
				!atRequestTime || !isLockControlType(atRequestTime.type),
				'the record’s audit identity space contains no control entry'
			);
			assert.strictEqual((await ClusterLockTest.get(recordId)).n, 7, 'and the holder’s write survived');
		});

		it('writes nothing for a node-scoped lock', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const before = controlEntries().length;
			const record = await ClusterLockTest.lock(id(), { hold: true, lease: 5000, scope: 'node' });
			assert.strictEqual(controlEntries().length, before, 'scope:node skips the cluster round entirely');
			await record.unlock();
			assert.strictEqual(controlEntries().length, before);
		});

		it('writes nothing, and behaves as Phase 0, with no transport registered', async function () {
			if (isLMDB) return this.skip();
			const before = controlEntries().length;
			const record = await ClusterLockTest.lock(id(), { hold: true, lease: 5000 });
			assert.strictEqual(controlEntries().length, before);
			assert.strictEqual(await record.unlock(), true);
		});
	});

	describe('fail-closed', () => {
		it('rejects with a retryable 503 when a peer cannot participate, and gives the key back', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport({
				participants: [
					{ nodeId: getThisNodeName(), capable: true },
					{ nodeId: 'legacy-peer', capable: false },
				],
			});
			const recordId = id();
			await assert.rejects(
				() => ClusterLockTest.lock(recordId, { hold: true, lease: 5000 }),
				(error) => error.statusCode === 503 && error.code === 'LOCK_UNAVAILABLE' && error.retryable === true
			);
			// The native key must not be left held by a round that failed.
			unregisterClusterLockTransport('test', true);
			const recovered = await ClusterLockTest.lock(recordId, { hold: true, lease: 5000, scope: 'node' });
			assert.strictEqual(await recovered.unlock(), true, 'the key was released when the round failed');
		});

		it('rejects on a worker that does not own lock coordination', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport({ owns: false });
			await assert.rejects(
				() => ClusterLockTest.lock(id(), { hold: true, lease: 5000 }),
				(error) => error.statusCode === 503
			);
		});

		it('rejects an explicit cluster scope when no transport is registered', async function () {
			if (isLMDB) return this.skip();
			await assert.rejects(
				() => ClusterLockTest.lock(id(), { hold: true, lease: 5000, scope: 'cluster' }),
				(error) => error.statusCode === 503 && error.code === 'LOCK_UNAVAILABLE'
			);
		});

		it('keeps rejecting after a registered transport disappears', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const warmUp = await ClusterLockTest.lock(id(), { hold: true, lease: 5000 });
			await warmUp.unlock();
			unregisterClusterLockTransport('test'); // no standalone claim: the database is still clustered
			await assert.rejects(
				() => ClusterLockTest.lock(id(), { hold: true, lease: 5000 }),
				(error) => error.statusCode === 503,
				'a transport that went away is not proof this node became standalone'
			);
		});

		it('refuses to hand a cluster lock to a caller that already holds the key node-scoped', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await assert.rejects(
				() =>
					transaction(async () => {
						await ClusterLockTest.lock(recordId, { scope: 'node', lease: 5000 });
						await ClusterLockTest.lock(recordId, { scope: 'cluster', lease: 5000 });
					}),
				(error) => error.statusCode === 409
			);
		});
	});

	describe('coalescing and cleanup', () => {
		it('coalesces two concurrent cluster locks on one key instead of self-blocking', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await ClusterLockTest.put({ id: recordId, n: 0 });
			const before = controlEntries().length;
			await transaction(async () => {
				const both = await Promise.all([
					ClusterLockTest.lock(recordId, { lease: 5000, timeout: 2000 }),
					ClusterLockTest.lock(recordId, { lease: 5000, timeout: 2000 }),
				]);
				assert.ok(both[0] && both[1], 'both callers get the lock');
			});
			assert.strictEqual(
				controlEntries()
					.slice(before)
					.filter((entry) => entry.type === 'lockRequest').length,
				1,
				'one cluster round, not one per caller'
			);
		});

		it('releases the transaction’s other locks when one of them lapses at commit', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const lapsing = id();
			const surviving = id();
			await ClusterLockTest.put({ id: lapsing, n: 1 });
			await ClusterLockTest.put({ id: surviving, n: 1 });
			await assert.rejects(
				() =>
					transaction(async () => {
						const short = await ClusterLockTest.lock(lapsing, { lease: 150 });
						const long = await ClusterLockTest.lock(surviving, { lease: 60_000 });
						short.set('n', 2);
						await short.save();
						long.set('n', 2);
						await long.save();
						await delay(500);
					}),
				(error) => error.statusCode === 409
			);
			// Without the commit path's cleanup the surviving key stays locked for its full 60 s lease
			// with no owner, and this re-lock times out.
			const relocked = await ClusterLockTest.lock(surviving, { hold: true, lease: 5000, timeout: 750 });
			assert.strictEqual(await relocked.unlock(), true, 'the other lock was not stranded');
		});
	});

	describe('lease fencing beyond the timer', () => {
		it('fences a commit even when the caller unlocked after the lease had lapsed', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await ClusterLockTest.put({ id: recordId, n: 1 });
			await assert.rejects(
				() =>
					transaction(async () => {
						const record = await ClusterLockTest.lock(recordId, { lease: 150 });
						record.set('n', 2);
						await record.save();
						await delay(500);
						// Giving the lock up deliberately does not make a lapsed lease valid again: peers
						// passed their own bound long ago and the key may already belong to someone else.
						await record.unlock();
					}),
				(error) => error.statusCode === 409
			);
			assert.strictEqual((await ClusterLockTest.get(recordId)).n, 1, 'the expired write never landed');
		});

		it('resolves a node id to a name per database, not process-wide', function () {
			if (isLMDB) return this.skip();
			const { pack } = require('msgpackr');
			const { getNodeNameForId } = require('#src/resources/nodeIdMapping');
			// Short ids are minted per database in first-seen order, so id 1 names a different node in
			// each one. A process-global inversion would attribute an entry to the wrong node.
			const storeFor = (mapping) => ({ getBinary: () => pack({ remoteNameToId: mapping }) });
			const alpha = storeFor({ [NODE_NAME]: 0, 'node-b': 1 });
			const beta = storeFor({ [NODE_NAME]: 0, 'node-c': 1 });
			assert.strictEqual(getNodeNameForId(alpha, 1), 'node-b');
			assert.strictEqual(getNodeNameForId(beta, 1), 'node-c');
			assert.strictEqual(getNodeNameForId(alpha, 1), 'node-b', 'and the first store is still itself');
		});
	});

	describe('exclusion from record-activity surfaces', () => {
		it('never delivers control entries to subscribers', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await ClusterLockTest.put({ id: recordId, n: 1 });
			const subscription = await ClusterLockTest.subscribe({ omitCurrent: true });
			const received = [];
			(async () => {
				for await (const event of subscription) received.push(event.type);
			})();

			const record = await ClusterLockTest.lock(recordId, { hold: true, lease: 5000 });
			await record.unlock();
			await ClusterLockTest.put({ id: recordId, n: 2 });
			// Wait for the ordinary write to arrive; anything the lock produced would have arrived first.
			const deadline = Date.now() + 5000;
			while (!received.includes('put') && Date.now() < deadline) await delay(20);
			subscription.close?.();
			assert.ok(received.includes('put'), 'the ordinary write is delivered');
			assert.deepStrictEqual(received.filter(isLockControlType), [], 'and no lock control entry reaches a subscriber');
		});

		it('excludes control entries from getHistory', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await ClusterLockTest.put({ id: recordId, n: 1 });
			const record = await ClusterLockTest.lock(recordId, { hold: true, lease: 5000 });
			await record.unlock();
			assert.ok(controlEntries().length > 0, 'the entries are in the log');
			const types = [];
			for await (const entry of ClusterLockTest.getHistory()) types.push(entry.type);
			assert.deepStrictEqual(types.filter(isLockControlType), [], 'but getHistory reports none of them');
		});
	});

	describe('lease fencing', () => {
		it('rejects a commit submitted after the lease elapsed, even though the write was already staged', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			await ClusterLockTest.put({ id: recordId, n: 1 });
			await assert.rejects(
				() =>
					transaction(async () => {
						const record = await ClusterLockTest.lock(recordId, { lease: 150 });
						record.n = 99;
						await record.save();
						// The commit is what submits; by the time it runs, every participant has written
						// this hold off.
						await delay(500);
					}),
				(error) => error.statusCode === 409
			);
			assert.strictEqual((await ClusterLockTest.get(recordId)).n, 1, 'the expired write never landed');
		});
	});
});
