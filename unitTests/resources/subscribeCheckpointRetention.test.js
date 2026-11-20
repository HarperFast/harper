// A checkpoint replay's retention recheck, the floor a store certifies on its own tick, and a checkpoint over two
// origins (the deferred findings of harper#3356).
const assert = require('node:assert');
const { utimesSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const {
	getAuditResumeFloor,
	getDatabaseGeneration,
	persistOriginClosedFloor,
	raiseAuditFloor,
	readOriginClosedFloor,
} = require('#src/resources/auditStore');
const {
	certifyOriginFloor,
	claimLocalKey,
	publishOriginFloor,
	getOriginClosedFloor,
} = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { MAX_OVERLAP_MS, membersDigest } = require('#src/resources/subscriptionCheckpoint');
const { getThisNodeName } = require('#src/server/nodeName');
const { transaction } = require('#src/resources/transaction');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';

let sequence = 0;
function tableInOwnDatabase() {
	const name = `ScalarResume${++sequence}`;
	return table({
		table: name,
		database: `scalar_resume_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }, { name: 'pad' }],
	});
}

function certify(T) {
	const rootStore = T.primaryStore.rootStore;
	let floor = certifyOriginFloor(rootStore);
	for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
	if (floor) {
		persistOriginClosedFloor(T.auditStore, floor);
		publishOriginFloor(rootStore, floor);
	}
	return getOriginClosedFloor(rootStore)?.floor ?? 0;
}

async function certifiedCheckpoint(T, subscription) {
	await sleep(2);
	const floor = certify(T);
	let checkpoint;
	await waitFor(() => {
		checkpoint = subscription.checkpoint();
		return checkpoint !== undefined && checkpoint.time >= floor;
	}, 10_000);
	return checkpoint;
}

const SEQ = Symbol.for('seq');

// a write replicated from `nodeId`, appended to that origin's log under the origin's key
function applyFromOrigin(T, id, record, nodeId, logKey) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await T.getResource(id, context);
		return resource._writeUpdate(id, record, true, { isNotification: true, nodeId, version: logKey });
	});
}

const logKeyOf = (T, id) => [...T.auditStore.getRange({ start: 1 })].find((entry) => entry.recordId === id).txnLogKey;
const valuesOf = (events) => events.map((event) => event.value?.value).filter((value) => value !== undefined);

describe('Checkpoint replay retention, the certified floor tick, and two origins (harper#3356)', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setOriginCaptureIntervalForTests(100);
	});
	after(() => setOriginCaptureIntervalForTests());

	describe('the retention recheck of a checkpoint replay', () => {
		const SEGMENT_PAD = 'x'.repeat(200_000);
		async function checkpointThenFill(T, pad, beforeFill) {
			const first = [];
			const subscription = await T.subscribe({
				omitCurrent: true,
				reportProgress: true,
				listener: (event) => first.push(event),
			});
			await T.put('a', { value: 'a' });
			await waitFor(() => valuesOf(first).includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			beforeFill?.();
			for (let i = 0; i < 250; i++) await T.put(`fill${i}`, { value: `fill${i}`, pad });
			return checkpoint;
		}
		// no consumer, so the replay stops at the queue's high-water mark, about 100 entries in
		async function replayHeldAtHighWater(T, checkpoint) {
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true });
			await waitFor(() => resumed.queue?.length > 100);
			return resumed;
		}

		it('passes when retention passes the start but only history the replay has read', async () => {
			const T = tableInOwnDatabase();
			const checkpoint = await checkpointThenFill(T);
			const resumed = await replayHeldAtHighWater(T, checkpoint);
			// nothing is removed: the floor reports what a prune may remove
			raiseAuditFloor(T.auditStore, logKeyOf(T, 'fill10'));
			assert.ok(getAuditResumeFloor(T.auditStore) > checkpoint.time - checkpoint.overlap, 'precondition');
			const events = [];
			resumed.on('data', (event) => events.push(event));
			assert.strictEqual(await resumed.resumeVerified, true);
			await waitFor(() => valuesOf(events).includes('fill249'));
			resumed.end();
		});

		it('passes when retention passes history the replay has read since it last yielded', async () => {
			const T = tableInOwnDatabase();
			const checkpoint = await checkpointThenFill(T);
			const prunedThrough = logKeyOf(T, 'fill230');
			const events = [];
			const resumed = await T.subscribe({
				resume: checkpoint,
				omitCurrent: true,
				listener: (event) => {
					events.push(event);
					if (event.value?.value === 'fill245') raiseAuditFloor(T.auditStore, prunedThrough);
				},
			});
			assert.strictEqual(await resumed.resumeVerified, true);
			assert.strictEqual(getAuditResumeFloor(T.auditStore), prunedThrough, 'precondition: the floor rose mid-replay');
			assert.ok(valuesOf(events).includes('fill249'));
			resumed.end();
		});

		it('refuses when retention passes history the replay has not read', async () => {
			const T = tableInOwnDatabase();
			const resumed = await replayHeldAtHighWater(T, await checkpointThenFill(T));
			raiseAuditFloor(T.auditStore, logKeyOf(T, 'fill240'));
			const events = [];
			resumed.on('data', (event) => events.push(event));
			assert.strictEqual(await resumed.resumeVerified, false);
			assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
			assert.ok(!valuesOf(events).includes('fill249'), 'the replay stopped');
		});

		it('passes when a purge removes only a log segment it has read', async () => {
			const T = tableInOwnDatabase();
			// about 80 entries to a 16 MB segment, so the replay stops in the second of four
			const checkpoint = await checkpointThenFill(T, SEGMENT_PAD);
			const log = T.auditStore.logByName.get('local');
			assert.ok(log.getStats().fileCount >= 3, 'precondition: the history spans several segments');
			const resumed = await replayHeldAtHighWater(T, checkpoint);
			const rootStore = T.primaryStore.rootStore;
			rootStore.flushSync();
			// a purge removes a segment by its last write, so only the first is aged past the cutoff
			const before = Date.now() - 60_000;
			utimesSync(join(log.path, '1.txnlog'), new Date(before - 60_000), new Date(before - 60_000));
			raiseAuditFloor(T.auditStore, logKeyOf(T, 'fill10'));
			assert.ok(getAuditResumeFloor(T.auditStore) > checkpoint.time - checkpoint.overlap, 'precondition');
			assert.strictEqual(
				rootStore.purgeLogs({ before }).length,
				1,
				'precondition: the purge removed the first segment'
			);
			const events = [];
			resumed.on('data', (event) => events.push(event));
			assert.strictEqual(await resumed.resumeVerified, true);
			await waitFor(() => valuesOf(events).includes('fill249'));
			assert.strictEqual(valuesOf(events).filter((value) => value.startsWith('fill')).length, 250);
			resumed.end();
		});

		it('refuses when a purge removes unread segments whose keys are ahead of the clock, and so above the floor', async () => {
			const T = tableInOwnDatabase();
			const rootStore = T.primaryStore.rootStore;
			// the claim raises the clock of the whole process, so the test ends only once the wall clock has passed it
			const ahead = Date.now() + 5000;
			try {
				const checkpoint = await checkpointThenFill(T, SEGMENT_PAD, () => claimLocalKey(rootStore, ahead));
				const resumed = await replayHeldAtHighWater(T, checkpoint);
				rootStore.flushSync();
				const before = Date.now() + 1;
				assert.ok(before < logKeyOf(T, 'fill0'), 'precondition: the history read is keyed above the cutoff');
				raiseAuditFloor(T.auditStore, before);
				assert.ok(rootStore.purgeLogs({ before }).length >= 3, 'precondition: the purge removed unread segments');
				const events = [];
				resumed.on('data', (event) => events.push(event));
				assert.strictEqual(await resumed.resumeVerified, false);
				assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
			} finally {
				await sleep(Math.max(0, rootStore.getMonotonicTimestamp() - Date.now()) + 1);
			}
		});

		it('refuses when a purge removes every log segment it has not read, which its reader does not report', async () => {
			const T = tableInOwnDatabase();
			// about 80 entries to a 16 MB segment, so the replay stops in the second of four
			const checkpoint = await checkpointThenFill(T, SEGMENT_PAD);
			const log = T.auditStore.logByName.get('local');
			assert.ok(log.getStats().fileCount >= 3, 'precondition: the history spans several segments');
			const resumed = await replayHeldAtHighWater(T, checkpoint);
			const rootStore = T.primaryStore.rootStore;
			rootStore.flushSync();
			const before = Date.now() + 1000;
			raiseAuditFloor(T.auditStore, before);
			assert.ok(rootStore.purgeLogs({ before }).length >= 3, 'precondition: the purge removed unread segments');
			const events = [];
			resumed.on('data', (event) => events.push(event));
			assert.strictEqual(await resumed.resumeVerified, false);
			assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
			assert.ok(!valuesOf(events).includes('fill249'));
		});
	});

	describe('the floor a store certifies on its own tick', function () {
		this.timeout(120_000);
		it('is advertised, and issues a checkpoint, only once its record has been synced', async () => {
			const T = tableInOwnDatabase();
			const rootStore = T.primaryStore.rootStore;
			const syncWal = rootStore.syncWal;
			assert.strictEqual(typeof syncWal, 'function', 'precondition: the pinned engine syncs the WAL');
			let synced;
			const mayLand = new Promise((resolve) => (synced = resolve));
			let syncs = 0;
			rootStore.syncWal = function (...args) {
				syncs++;
				return mayLand.then(() => syncWal.apply(this, args));
			};
			try {
				const events = [];
				const subscription = await T.subscribe({
					omitCurrent: true,
					reportProgress: true,
					listener: (event) => events.push(event),
				});
				await T.put('a', { value: 'a' });
				await waitFor(() => valuesOf(events).includes('a'));
				// no test-side certification: the store's maintenance tick persists a floor and waits for its sync
				await waitFor(() => syncs > 0, 30_000, 50);
				const persisted = readOriginClosedFloor(T.auditStore);
				assert.ok(persisted > logKeyOf(T, 'a'), 'the tick persisted a floor past the write');
				assert.ok(!(getOriginClosedFloor(rootStore)?.floor >= persisted), 'an unsynced floor is not advertised');
				assert.strictEqual(subscription.checkpoint(), undefined, 'and certifies nothing');
				synced();
				let checkpoint;
				await waitFor(() => (checkpoint = subscription.checkpoint()) !== undefined, 30_000, 50);
				assert.ok(getOriginClosedFloor(rootStore).floor >= persisted);
				assert.ok(checkpoint.time >= persisted, 'the checkpoint carries the floor the tick published');
				subscription.end();
			} finally {
				synced();
				rootStore.syncWal = syncWal;
			}
		});
	});

	describe('two origins', () => {
		// a peer whose floor is further ahead than one common boundary covers, so this node's own origin is the one named
		async function checkpointWithPeerAhead(T, peerId) {
			const events = [];
			const subscription = await T.subscribe({
				omitCurrent: true,
				reportProgress: true,
				listener: (event) => events.push(event),
			});
			await T.put('a', { value: 'a' });
			await waitFor(() => valuesOf(events).includes('a'));
			await sleep(2);
			const ownFloor = certify(T);
			const peerFloor = ownFloor + MAX_OVERLAP_MS + 60_000;
			await applyFromOrigin(T, 'p1', { id: 'p1', value: 'p1' }, peerId, ownFloor + 1000);
			await waitFor(() => valuesOf(events).includes('p1'));
			T.dbisDB.putSync([SEQ, peerId], {
				seqId: 1,
				nodes: [
					{
						id: peerId,
						closedFloor: peerFloor,
						originGeneration: 'peer-generation',
						fullCoverage: true,
						certifiedFrom: 0,
					},
				],
			});
			const members = membersDigest([
				[getThisNodeName(), getDatabaseGeneration(T.auditStore).id],
				['peer-ahead', 'peer-generation'],
			]);
			let checkpoint;
			await waitFor(() => (checkpoint = subscription.checkpoint())?.members === members, 10_000);
			subscription.end();
			return { checkpoint, ownFloor, peerFloor };
		}

		it('names the origin that lags the common boundary and resumes each from its own', async () => {
			const T = tableInOwnDatabase();
			const peerId = getIdOfRemoteNode('peer-ahead', T.auditStore);
			const { checkpoint, ownFloor, peerFloor } = await checkpointWithPeerAhead(T, peerId);
			assert.deepStrictEqual(
				Object.keys(checkpoint.exceptions),
				[getThisNodeName()],
				'only the lagging origin is named'
			);
			const ownBoundary = checkpoint.exceptions[getThisNodeName()];
			const commonBoundary = checkpoint.time - checkpoint.overlap;
			assert.strictEqual(checkpoint.time, peerFloor);
			assert.ok(ownBoundary <= ownFloor && ownFloor + 1000 < commonBoundary, 'precondition: p1 lies between the two');
			await T.put('b', { value: 'b' });
			await applyFromOrigin(T, 'p2', { id: 'p2', value: 'p2' }, peerId, peerFloor + 1000);
			const replayed = [];
			const resumed = await T.subscribe({
				resume: checkpoint,
				omitCurrent: true,
				listener: (event) => replayed.push(event),
			});
			assert.strictEqual(await resumed.resumeVerified, true);
			await waitFor(() => valuesOf(replayed).includes('b') && valuesOf(replayed).includes('p2'));
			// p1 is above this node's boundary but below the peer's, so only a per-log start leaves it out
			assert.ok(!valuesOf(replayed).includes('p1'), 'the peer resumes from the common boundary');
			assert.ok(valuesOf(replayed).includes('b'), 'this node resumes from its own, far below it');
			resumed.end();
		});

		it('refuses when retention passes what one log has read, though the replay is further on in another', async () => {
			const T = tableInOwnDatabase();
			const peerId = getIdOfRemoteNode('peer-ahead', T.auditStore);
			const { checkpoint, peerFloor } = await checkpointWithPeerAhead(T, peerId);
			for (let i = 0; i < 50; i++) await T.put(`local${i}`, { value: `local${i}` });
			for (let i = 0; i < 150; i++) {
				await applyFromOrigin(T, `peer${i}`, { id: `peer${i}`, value: `peer${i}` }, peerId, peerFloor + 1000 + i);
			}
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true });
			await waitFor(() => resumed.queue?.length > 100);
			assert.match(resumed.queue.at(-1).value.value, /^peer/, 'precondition: the replay stopped in the peer log');
			// above every key of this node's log, which may hold more than the replay read, and below the peer's
			raiseAuditFloor(T.auditStore, Date.now() + 10_000);
			assert.ok(getAuditResumeFloor(T.auditStore) < peerFloor, 'precondition');
			const events = [];
			resumed.on('data', (event) => events.push(event));
			assert.strictEqual(await resumed.resumeVerified, false);
			assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
		});
	});
});
