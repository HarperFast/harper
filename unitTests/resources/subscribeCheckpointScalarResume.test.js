// A reportProgress subscription that starts from a scalar position certifies every entry appended after it
// registered, so its replay may drop only what it delivers itself. Also here: the retention recheck of a checkpoint
// replay, the floor a store certifies on its own tick, and a checkpoint over two origins.
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

let sequence = 0;
function tableInOwnDatabase() {
	const name = `ScalarResume${++sequence}`;
	return table({
		table: name,
		database: `scalar_resume_${name}`,
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

// its write takes its log key now, and commits only when the returned function is called
async function heldTransaction(write) {
	let commit;
	const committed = transaction({}, async (context) => {
		await write(context);
		await new Promise((resolve) => (commit = resolve));
	});
	await waitFor(() => commit);
	return () => {
		commit();
		return committed;
	};
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

describe('Checkpoints of a subscription that started from a scalar position (harper#3356)', function () {
	if (!isRocksDB) return;
	this.timeout(60_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		setOriginCaptureIntervalForTests(100);
	});
	after(() => setOriginCaptureIntervalForTests());

	describe('a collection replay', () => {
		it('delivers a transaction that commits below the start while the replay is still running', async () => {
			const T = tableInOwnDatabase();
			const commitLate = await heldTransaction((context) => T.put('late', { value: 'late' }, context));
			await T.put('first', { value: 'first' });
			const startTime = logKeyOf(T, 'first');
			for (let i = 0; i < 150; i++) await T.put(`fill${i}`, { value: `fill${i}` });
			// no consumer yet, so the replay stops at the queue's high-water mark until it is drained
			const subscription = await T.subscribe({ startTime, isCollection: true, reportProgress: true });
			await waitFor(() => subscription.queue?.length > 100);
			await commitLate();
			assert.ok(logKeyOf(T, 'late') < startTime, 'precondition: the held transaction committed below the start');
			await T.put('after', { value: 'after' });
			assert.strictEqual(subscription.checkpoint(), undefined, 'nothing is certified while the replay runs');
			const events = [];
			subscription.on('data', (event) => events.push(event));
			await waitFor(() => valuesOf(events).includes('after'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			assert.ok(checkpoint.time - checkpoint.overlap > logKeyOf(T, 'late'), 'the checkpoint certifies past it');
			const values = valuesOf(events);
			assert.strictEqual(values.filter((value) => value === 'late').length, 1, 'the late commit is delivered once');
			for (let i = 0; i < 150; i++) {
				assert.strictEqual(values.filter((value) => value === `fill${i}`).length, 1, `fill${i} is delivered once`);
			}
			subscription.end();
		});
	});

	describe('a single-record walk', () => {
		for (const start of ['startTime', 'previousCount']) {
			it(`delivers a message that commits below the head while the ${start} walk is still running`, async () => {
				const T = tableInOwnDatabase();
				await T.put('seed', { value: 'seed' });
				const position = start === 'startTime' ? { startTime: logKeyOf(T, 'seed') } : { previousCount: 1000 };
				// the put takes the transaction's log key now, which its message shares
				const commitLate = await heldTransaction(async (context) => {
					await T.put('other', { value: 'other' }, context);
					await T.publish('r', { value: 'late' }, context);
				});
				await T.put('r', { value: 'r0' });
				for (let i = 0; i < 3000; i++) await T.publish('r', { value: `m${i}` });
				const events = [];
				let committing;
				let walked = 0;
				let walkedAtCommit;
				const subscription = await T.subscribe({
					id: 'r',
					...position,
					reportProgress: true,
					omitCurrent: true,
					filterKey: 'all',
					// the walk calls this for each entry it reads, so the commit starts once the walk has taken the head
					eventFilter: (event) => {
						if (event.value?.value !== 'late' && event.value?.value !== 'after') walked++;
						committing ??= commitLate().then(() => (walkedAtCommit = walked));
						return true;
					},
					listener: (event) => events.push(event),
				});
				await waitFor(() => committing !== undefined);
				await committing;
				await T.publish('r', { value: 'after' });
				await waitFor(() => valuesOf(events).includes('after'));
				// the walk yields every 100 entries, so the broadcast dispatched the commit while the walk was running
				assert.ok(
					walkedAtCommit <= walked - 200,
					`precondition: the commit landed mid-walk (${walkedAtCommit}/${walked})`
				);
				const values = valuesOf(events);
				assert.ok(values.includes('m2999'), 'precondition: the walk replayed the history');
				assert.strictEqual(values.filter((value) => value === 'late').length, 1, 'the late message is delivered once');
				assert.strictEqual(values.filter((value) => value === 'm2999').length, 1);
				subscription.end();
			});
		}

		it('delivers once a write the walk read before the broadcast reached it', async () => {
			const T = tableInOwnDatabase();
			await T.put('seed', { value: 'seed' });
			const startTime = logKeyOf(T, 'seed');
			const other = await T.subscribe({ omitCurrent: true, listener: () => {} });
			// one transaction far longer than a broadcast batch, so the broadcast is still behind when the walk reads r
			await transaction({}, async (context) => {
				for (let i = 0; i < 6000; i++) await T.put(`other${i}`, { value: i }, context);
				await T.put('r', { value: 'r1' }, context);
			});
			const events = [];
			const subscription = await T.subscribe({
				id: 'r',
				startTime,
				reportProgress: true,
				omitCurrent: true,
				listener: (event) => events.push(event),
			});
			const broadcast = T.auditStore.subscriptionLogRange;
			assert.ok(broadcast.hasUnreturnedEntry(), 'precondition: the broadcast is behind the log');
			assert.deepStrictEqual(valuesOf(events), ['r1'], 'the walk delivered it');
			// a superseding write would hide the first from live delivery, so it waits for the broadcast to pass it
			await waitFor(() => !broadcast.hasUnreturnedEntry());
			await T.put('r', { value: 'r2' });
			await waitFor(() => valuesOf(events).includes('r2'));
			assert.deepStrictEqual(valuesOf(events), ['r1', 'r2']);
			assert.strictEqual(subscription.state.replayed, undefined, 'what the walk delivered is no longer kept');
			subscription.end();
			other.end();
		});

		it('delivers once a message whose transaction holds another the filter refuses', async () => {
			const T = tableInOwnDatabase();
			await T.put('seed', { value: 'seed' });
			const startTime = logKeyOf(T, 'seed');
			const other = await T.subscribe({ omitCurrent: true, listener: () => {} });
			await transaction({}, async (context) => {
				for (let i = 0; i < 6000; i++) await T.put(`other${i}`, { value: i }, context);
				await T.publish('r', { value: 'refused' }, context);
				await T.publish('r', { value: 'accepted' }, context);
			});
			const events = [];
			const subscription = await T.subscribe({
				id: 'r',
				startTime,
				reportProgress: true,
				omitCurrent: true,
				filterKey: 'accepted',
				eventFilter: (event) => event.value?.value !== 'refused',
				listener: (event) => events.push(event),
			});
			const broadcast = T.auditStore.subscriptionLogRange;
			assert.ok(broadcast.hasUnreturnedEntry(), 'precondition: the broadcast is behind the log');
			await waitFor(() => !broadcast.hasUnreturnedEntry());
			await T.publish('r', { value: 'after' });
			await waitFor(() => valuesOf(events).includes('after'));
			assert.deepStrictEqual(valuesOf(events), ['accepted', 'after']);
			subscription.end();
			other.end();
		});

		it('keeps nothing of a walk when the broadcast has caught up and no write is committing', async () => {
			const T = tableInOwnDatabase();
			await T.put('seed', { value: 'seed' });
			const startTime = logKeyOf(T, 'seed');
			const other = await T.subscribe({ omitCurrent: true, listener: () => {} });
			await T.put('r', { value: 'r1' });
			await waitFor(() => !T.auditStore.subscriptionLogRange.hasUnreturnedEntry());
			const events = [];
			const subscription = await T.subscribe({
				id: 'r',
				startTime,
				reportProgress: true,
				omitCurrent: true,
				listener: (event) => events.push(event),
			});
			assert.deepStrictEqual(valuesOf(events), ['r1']);
			assert.strictEqual(subscription.state.replayed, undefined);
			assert.strictEqual(subscription.state.dropDuringReplay, false);
			subscription.end();
			other.end();
		});
	});

	describe('the retention recheck of a checkpoint replay', () => {
		async function checkpointThenFill(T) {
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
			for (let i = 0; i < 250; i++) await T.put(`fill${i}`, { value: `fill${i}` });
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

		it('passes when retention passes history read since the last check, at the end of the replay', async () => {
			const T = tableInOwnDatabase();
			const checkpoint = await checkpointThenFill(T);
			const prunedThrough = logKeyOf(T, 'fill230');
			const events = [];
			// a consumer that keeps up: the replay checks only every 100 entries, the last time near fill200
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
		it('names the origin that lags the common boundary and resumes each from its own', async () => {
			const T = tableInOwnDatabase();
			const peerId = getIdOfRemoteNode('peer-ahead', T.auditStore);
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
			// The peer's floor is further ahead than one common boundary covers, so this node's own origin is the one
			// named. (A database made a moment ago retains nothing a boundary a minute behind its own floor needs.)
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
			assert.deepStrictEqual(
				Object.keys(checkpoint.exceptions),
				[getThisNodeName()],
				'only the lagging origin is named'
			);
			const ownBoundary = checkpoint.exceptions[getThisNodeName()];
			const commonBoundary = checkpoint.time - checkpoint.overlap;
			assert.strictEqual(checkpoint.time, peerFloor);
			assert.ok(ownBoundary <= ownFloor && ownFloor + 1000 < commonBoundary, 'precondition: p1 lies between the two');
			subscription.end();
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
	});
});
