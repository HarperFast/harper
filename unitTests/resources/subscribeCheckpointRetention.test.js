const assert = require('node:assert');
const { readdirSync, utimesSync } = require('node:fs');
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
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { MAX_OVERLAP_MS, membersDigest } = require('#src/resources/subscriptionCheckpoint');
const { getThisNodeName } = require('#src/server/nodeName');
const { transaction } = require('#src/resources/transaction');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
// Windows refuses to delete a log segment a replay has mapped (resources/audit-retention.md)
const canUnlinkMappedSegments = process.platform !== 'win32';

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

function applyFromOrigin(T, id, record, nodeId, logKey) {
	const context = { source: {}, sourceApply: true, timestamp: logKey };
	return transaction(context, async () => {
		const resource = await T.getResource(id, context);
		return resource._writeUpdate(id, record, true, { isNotification: true, nodeId, version: logKey });
	});
}

const logKeyOf = (T, id) => [...T.auditStore.getRange({ start: 1 })].find((entry) => entry.recordId === id).txnLogKey;
const valuesOf = (events) => events.map((event) => event.value?.value).filter((value) => value !== undefined);

async function assertRefused(resumed) {
	const events = [];
	resumed.on('data', (event) => events.push(event));
	assert.strictEqual(await resumed.resumeVerified, false);
	assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
	return events;
}

// A purge removes a segment by its last write. Aged segments stand for ones written while keys were minted ahead of
// the clock: their keys are above a cutoff that their last write is before.
const AGED = 3_600_000;
function purgeAged(T) {
	const log = T.auditStore.logByName.get('local');
	const aged = new Date(Date.now() - AGED);
	for (const file of readdirSync(log.path)) if (file.endsWith('.txnlog')) utimesSync(join(log.path, file), aged, aged);
	return T.primaryStore.rootStore.purgeLogs({ before: Date.now() - AGED / 2 });
}

describe('The certified floor tick, two-origin checkpoints, and checkpoint replay retention (harper#3356)', function () {
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
		async function checkpointThenFill(T, pad) {
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
			for (let i = 0; i < 250; i++) await T.put(`fill${i}`, { value: `fill${i}`, pad });
			return checkpoint;
		}
		async function replayHeldAtHighWater(T, checkpoint) {
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true });
			await waitFor(() => resumed.queue?.length > 100);
			return resumed;
		}

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

		it('refuses when a purge removes unread segments keyed above the floor, which has passed the start', async function () {
			if (!canUnlinkMappedSegments) return this.skip();
			const T = tableInOwnDatabase();
			// about 80 entries to a 16 MB segment, so the replay stops in the second of four
			const checkpoint = await checkpointThenFill(T, SEGMENT_PAD);
			const resumed = await replayHeldAtHighWater(T, checkpoint);
			T.primaryStore.rootStore.flushSync();
			raiseAuditFloor(T.auditStore, logKeyOf(T, 'fill10'));
			assert.ok(getAuditResumeFloor(T.auditStore) > checkpoint.time - checkpoint.overlap, 'precondition');
			assert.ok(purgeAged(T).length >= 3, 'precondition: the purge removed unread segments');
			await assertRefused(resumed);
		});

		it('refuses when a purge removes every log segment it has not read, which its reader does not report', async function () {
			if (!canUnlinkMappedSegments) return this.skip();
			const T = tableInOwnDatabase();
			const checkpoint = await checkpointThenFill(T, SEGMENT_PAD);
			const log = T.auditStore.logByName.get('local');
			assert.ok(log.getStats().fileCount >= 3, 'precondition: the history spans several segments');
			const resumed = await replayHeldAtHighWater(T, checkpoint);
			const rootStore = T.primaryStore.rootStore;
			rootStore.flushSync();
			const before = Date.now() + 1000;
			raiseAuditFloor(T.auditStore, before);
			assert.ok(rootStore.purgeLogs({ before }).length >= 3, 'precondition: the purge removed unread segments');
			const events = await assertRefused(resumed);
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

		async function replayHeldInPeerLog(T, checkpoint, peerId, firstPeerKey) {
			for (let i = 0; i < 50; i++) await T.put(`local${i}`, { value: `local${i}` });
			for (let i = 0; i < 150; i++) {
				await applyFromOrigin(T, `peer${i}`, { id: `peer${i}`, value: `peer${i}` }, peerId, firstPeerKey + i);
			}
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true });
			await waitFor(() => resumed.queue?.length > 100);
			assert.match(resumed.queue.at(-1).value.value, /^peer/, 'precondition: the replay stopped in the peer log');
			T.primaryStore.rootStore.flushSync();
			return resumed;
		}
		const purgePeerLog = (T, name) => T.primaryStore.rootStore.purgeLogs({ before: Date.now() + 1, name });

		it("refuses when a purge removes unread history of a peer's log, once the floor has passed this node's start", async function () {
			if (!canUnlinkMappedSegments) return this.skip();
			const T = tableInOwnDatabase();
			const peerId = getIdOfRemoteNode('peer-ahead', T.auditStore);
			const { checkpoint, peerFloor } = await checkpointWithPeerAhead(T, peerId);
			const resumed = await replayHeldInPeerLog(T, checkpoint, peerId, peerFloor + 1000);
			raiseAuditFloor(T.auditStore, logKeyOf(T, 'local10'));
			assert.ok(getAuditResumeFloor(T.auditStore) > checkpoint.exceptions[getThisNodeName()], 'precondition');
			assert.ok(purgePeerLog(T, 'peer-ahead').length >= 1, "precondition: the purge removed the peer's log");
			await assertRefused(resumed);
		});

		it('refuses when a purge empties the log of a peer read from its beginning, once the floor has passed the start', async function () {
			if (!canUnlinkMappedSegments) return this.skip();
			const T = tableInOwnDatabase();
			const events = [];
			const subscription = await T.subscribe({
				omitCurrent: true,
				reportProgress: true,
				listener: (event) => events.push(event),
			});
			await T.put('a', { value: 'a' });
			await waitFor(() => valuesOf(events).includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			// the checkpoint does not name this origin, so its whole log is replayed
			const peerId = getIdOfRemoteNode('peer-new', T.auditStore);
			const firstPeerKey = Date.now() + 60_000;
			T.dbisDB.putSync([SEQ, peerId], {
				seqId: 1,
				nodes: [
					{
						id: peerId,
						closedFloor: firstPeerKey,
						originGeneration: 'peer-generation',
						fullCoverage: true,
						certifiedFrom: 0,
					},
				],
			});
			const resumed = await replayHeldInPeerLog(T, checkpoint, peerId, firstPeerKey);
			raiseAuditFloor(T.auditStore, logKeyOf(T, 'local10'));
			assert.ok(getAuditResumeFloor(T.auditStore) > checkpoint.time - checkpoint.overlap, 'precondition');
			assert.ok(purgePeerLog(T, 'peer-new').length >= 1, "precondition: the purge emptied the peer's log");
			await assertRefused(resumed);
		});
	});
});
