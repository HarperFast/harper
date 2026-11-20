const assert = require('node:assert');
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
const CAPTURE_INTERVAL_MS = 100;

let sequence = 0;
function tableInOwnDatabase() {
	const name = `CheckpointOrigins${++sequence}`;
	return table({
		table: name,
		database: `checkpoint_origins_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
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

describe('The certified floor tick and two-origin checkpoints (harper#3356)', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setOriginCaptureIntervalForTests(CAPTURE_INTERVAL_MS);
	});
	after(() => setOriginCaptureIntervalForTests());

	describe('the floor a store certifies on its own tick', function () {
		this.timeout(120_000);
		it('is advertised, and issues a checkpoint, only once its record has been synced', async () => {
			const T = tableInOwnDatabase();
			const rootStore = T.primaryStore.rootStore;
			const syncWal = rootStore.syncWal;
			assert.strictEqual(typeof syncWal, 'function', 'precondition: the pinned engine syncs the WAL');
			let synced;
			const mayLand = new Promise((resolve) => (synced = resolve));
			// an earlier tick can persist a floor sampled before the write, so only one that covers it is held
			let keyOfWrite = Infinity;
			let held = 0;
			rootStore.syncWal = function (...args) {
				if (!(readOriginClosedFloor(T.auditStore) > keyOfWrite)) return syncWal.apply(this, args);
				held++;
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
				keyOfWrite = logKeyOf(T, 'a');
				await waitFor(() => held > 0, 30_000, 50);
				const persisted = readOriginClosedFloor(T.auditStore);
				assert.ok(persisted > keyOfWrite, 'the tick persisted a floor past the write');
				// several capture intervals, so a floor advertised early would have reached a checkpoint
				await sleep(CAPTURE_INTERVAL_MS * 5);
				assert.ok(!(getOriginClosedFloor(rootStore)?.floor >= persisted), 'an unsynced floor is not advertised');
				assert.ok(!(subscription.checkpoint()?.time >= persisted), 'and no checkpoint carries it');
				synced();
				await waitFor(() => subscription.checkpoint()?.time >= persisted, 30_000, 50);
				assert.ok(getOriginClosedFloor(rootStore).floor >= persisted, 'the synced floor is advertised');
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
			// far enough above this node's floor that its own tick does not certify past it during the test
			const p1Key = ownFloor + MAX_OVERLAP_MS / 2;
			await applyFromOrigin(T, 'p1', { id: 'p1', value: 'p1' }, peerId, p1Key);
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
			return { checkpoint, p1Key, peerFloor };
		}

		it('names the origin that lags the common boundary and resumes each from its own', async () => {
			const T = tableInOwnDatabase();
			const peerId = getIdOfRemoteNode('peer-ahead', T.auditStore);
			const { checkpoint, p1Key, peerFloor } = await checkpointWithPeerAhead(T, peerId);
			assert.deepStrictEqual(
				Object.keys(checkpoint.exceptions),
				[getThisNodeName()],
				'only the lagging origin is named'
			);
			const ownBoundary = checkpoint.exceptions[getThisNodeName()];
			const commonBoundary = checkpoint.time - checkpoint.overlap;
			assert.strictEqual(checkpoint.time, peerFloor);
			assert.ok(ownBoundary < p1Key && p1Key < commonBoundary, 'precondition: p1 lies between the two');
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
			assert.ok(getAuditResumeFloor(T.auditStore) < checkpoint.time - checkpoint.overlap, 'precondition');
			const events = [];
			resumed.on('data', (event) => events.push(event));
			assert.strictEqual(await resumed.resumeVerified, false);
			assert.strictEqual(events.at(-1)?.code, 'RESUME_HISTORY_UNAVAILABLE');
		});
	});
});
