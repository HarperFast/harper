const assert = require('assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
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
const { IterableEventQueue } = require('#src/resources/IterableEventQueue');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Cluster record locks (harper#483 Phase 1) against a real table: what the in-memory coordinator
// suite cannot prove — that a control entry encodes, commits, decodes and stays out of every surface
// that reports record activity, and that it does not collide with the holder's own audit entry.
describe('Cluster record locks on a real table (harper#483 Phase 1)', () => {
	let ClusterLockTest;
	let SinkLockTest;
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
		SinkLockTest = table({
			table: 'SinkLockTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
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

	/** Every lock control entry currently in a table's transaction log, eagerly materialized. */
	function controlEntries(forTable = ClusterLockTest) {
		const found = [];
		for (const entry of forTable.auditStore.getRange({ start: 1 })) {
			if (entry.tableId !== forTable.tableId || !isLockControlType(entry.type)) continue;
			found.push({
				type: entry.type,
				recordId: entry.recordId,
				version: entry.version,
				extendedType: entry.extendedType,
				value: entry.getValue(forTable.primaryStore),
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
			// ts_R is minted before the write and lives in the payload; the entry takes a fresh commit
			// time so it can never land behind a peer's replication cursor.
			assert.ok(decoded.tsR > 0 && decoded.tsR <= request.version, 'ts_R was minted before the entry committed');
			assert.strictEqual(decoded.leaseMs, 5000);

			await record.unlock();
			// unlock() is synchronous by contract; the durable release is best-effort and lands after.
			await waitFor(() => controlEntries().some((entry) => entry.type === 'lockRelease'));
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

		it('fails an explicit cluster request closed even on a key this transaction already holds', async function () {
			if (isLMDB) return this.skip();
			useSoloTransport();
			const recordId = id();
			const warmUp = await ClusterLockTest.lock(recordId, { hold: true, lease: 5000 });
			await warmUp.unlock();
			unregisterClusterLockTransport('test'); // still clustered; the transport just went away
			await assert.rejects(
				() =>
					transaction(async () => {
						await ClusterLockTest.lock(recordId, { scope: 'node', lease: 5000 });
						// The re-entrant path must not hand the node-local handle back for this request.
						await ClusterLockTest.lock(recordId, { scope: 'cluster', lease: 5000 });
					}),
				(error) => error.statusCode === 503
			);
		});

		it('routes a control entry through the real replication sink, not to a record', async function () {
			if (isLMDB) return this.skip();
			const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
			const { encodeLockControlPayload } = require('#src/resources/recordLockCoordinator');
			const { unpack } = require('msgpackr');
			const peerId = getIdOfRemoteNode('peer-sink', ClusterLockTest.auditStore);
			useSoloTransport({
				participants: [
					{ nodeId: NODE_NAME, capable: true },
					{ nodeId: 'peer-sink', capable: true },
				],
			});
			// A source is how replication attaches, so this is the path applyLockControlEvent sits on:
			// the sink decodes the payload, resolves the author from the audit nodeId, and routes.
			const events = new IterableEventQueue();
			SinkLockTest.sourcedFrom(
				{ subscribe: () => events, subscribeOnThisThread: () => true },
				{
					intermediateSource: true,
				}
			);
			const recordId = id();
			const wire = {
				type: 'lockRequest',
				key: recordId,
				requester: 'peer-sink',
				tsR: Date.now(),
				leaseMs: 5000,
				waitMs: 5000,
			};
			events.send({
				type: 'lockRequest',
				table: 'SinkLockTest',
				id: null,
				value: unpack(encodeLockControlPayload(wire)),
				nodeId: peerId,
				timestamp: wire.tsR,
			});
			// The grant this node owes the peer is the observable effect of the entry being routed.
			await waitFor(() =>
				controlEntries(SinkLockTest).some((entry) => entry.type === 'lockGrant' && entry.value[1] === 'peer-sink')
			);
			assert.ok(!(await SinkLockTest.get(recordId)), 'and no record was written for it');
		});

		it('routes a replicated control entry to the coordinator and never to a record', async function () {
			if (isLMDB) return this.skip();
			const {
				decodeLockControlPayload,
				encodeLockControlPayload,
				deliverLockControlEntry,
			} = require('#src/resources/recordLockCoordinator');
			const { unpack } = require('msgpackr');
			useSoloTransport({
				participants: [
					{ nodeId: NODE_NAME, capable: true },
					{ nodeId: 'peer-1', capable: true },
				],
			});
			const recordId = id();
			// The receive path a sender drives: encode, decode as the table decoder would, route.
			const wire = {
				type: 'lockRequest',
				key: recordId,
				requester: 'peer-1',
				tsR: Date.now(),
				leaseMs: 5000,
				waitMs: 5000,
			};
			const decoded = decodeLockControlPayload(wire.type, unpack(encodeLockControlPayload(wire)));
			assert.deepStrictEqual(decoded, wire, 'the payload survives the round trip');
			deliverLockControlEntry('test', 'ClusterLockTest', decoded, 'peer-1');
			assert.ok(!(await ClusterLockTest.get(recordId)), 'no record was created');
			const coordinator = ClusterLockTest.lockCoordinator;
			assert.ok(coordinator, 'the coordinator resolved through the registry');
			// Granted, not deferred: this node holds nothing on that key.
			assert.strictEqual(coordinator.stats.deferred, 0);
		});

		it('contains a malformed control entry instead of failing the apply loop', function () {
			if (isLMDB) return this.skip();
			const { decodeLockControlPayload, deliverLockControlEntry } = require('#src/resources/recordLockCoordinator');
			useSoloTransport({
				participants: [
					{ nodeId: NODE_NAME, capable: true },
					{ nodeId: 'peer-1', capable: true },
				],
			});
			// A key the decoder must refuse, because keyIdOf would throw encoding it.
			assert.strictEqual(
				decodeLockControlPayload('lockRequest', [{ not: 'a key' }, 'peer-1', Date.now(), 5000, 5000]),
				undefined
			);
			// And anything that still gets through must not escape into the replicated apply loop.
			assert.doesNotThrow(() =>
				deliverLockControlEntry(
					'test',
					'ClusterLockTest',
					{
						type: 'lockRequest',
						key: { not: 'a key' },
						requester: 'peer-1',
						tsR: Date.now(),
						leaseMs: 5000,
						waitMs: 5000,
					},
					'peer-1'
				)
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

		it('exposes the coordinator on the entry the replication sink resolves', function () {
			if (isLMDB) return this.skip();
			const { databases } = require('#src/resources/databases');
			// applyLockControlEvent and the transport resolver both reach the coordinator through
			// databases[db][table], so that entry has to be the Table class the static getter lives on.
			useSoloTransport();
			const viaRegistry = databases.test?.ClusterLockTest;
			assert.strictEqual(viaRegistry, ClusterLockTest, 'the registry holds the table class itself');
			assert.ok(viaRegistry.lockCoordinator, 'and its coordinator resolves through that path');
			unregisterClusterLockTransport('test', true);
			assert.strictEqual(viaRegistry.lockCoordinator, undefined, 'and goes away with the transport');
		});

		it('picks up a node admitted after this worker cached the mapping', async function () {
			if (isLMDB) return this.skip();
			const { pack } = require('msgpackr');
			const { getNodeNameForId } = require('#src/resources/nodeIdMapping');
			// Ids are minted by whichever worker first talks to a peer, and invalidation only reaches
			// that worker. Every other one holds a map that predates the new node, so a miss has to be
			// able to re-read — trusting the cache for misses strands the new peer permanently.
			let mapping = { [NODE_NAME]: 0, 'node-b': 1 };
			const store = { getBinary: () => pack({ remoteNameToId: mapping }) };
			assert.strictEqual(getNodeNameForId(store, 1), 'node-b');
			assert.strictEqual(getNodeNameForId(store, 2), undefined, 'node-c is not in the cluster yet');
			mapping = { ...mapping, 'node-c': 2 };
			await delay(120); // past the miss-refresh window
			assert.strictEqual(getNodeNameForId(store, 2), 'node-c', 'and is resolved once it joins');
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
