const assert = require('node:assert');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { getDatabaseGeneration, persistOriginClosedFloor } = require('#src/resources/auditStore');
const { certifyOriginFloor, publishOriginFloor, getOriginClosedFloor } = require('#src/resources/originClosedFloor');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { getThisNodeName } = require('#src/server/nodeName');
const { transaction } = require('#src/resources/transaction');
const { setOriginCaptureIntervalForTests } = require('#src/resources/transactionBroadcast');
const {
	COPY_BOUND_KEY,
	MAX_OVERLAP_MS,
	encodeCheckpoint,
	membersDigest,
	positionBefore,
	readCopyBounds,
	readOriginStateEpoch,
	resolveMembership,
	validateCheckpoint,
	writeCopyBounds,
} = require('#src/resources/subscriptionCheckpoint');
const { suspendDatabaseCommits } = require('#src/resources/DatabaseTransaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const SEQ = Symbol.for('seq');

let sequence = 0;
function tableInOwnDatabase(name = `Checkpoint${++sequence}`) {
	return table({
		table: name,
		database: `checkpoint_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
}

/** One certification round, as the maintenance tick runs it. */
function certify(T) {
	const rootStore = T.primaryStore.rootStore;
	// a floor certifies only once synced; the pinned engine may predate syncWal, so the tick's sync is stood in for
	if (typeof rootStore.syncWal !== 'function') rootStore.syncWal = () => Promise.resolve();
	let floor = certifyOriginFloor(rootStore);
	for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
	if (floor) {
		persistOriginClosedFloor(T.auditStore, floor);
		publishOriginFloor(rootStore, floor);
	}
	return getOriginClosedFloor(rootStore)?.floor ?? 0;
}

/** Waits for a checkpoint whose common boundary reflects the floor certified now. */
async function certifiedCheckpoint(T, subscription, holds) {
	await sleep(2);
	const floor = certify(T);
	let checkpoint;
	await waitFor(() => {
		checkpoint = subscription.checkpoint(holds);
		return checkpoint !== undefined && checkpoint.time >= floor;
	}, 10_000);
	return checkpoint;
}

// its writes take its log key now, so it commits below whatever commits before the returned function is called
async function heldTransaction(T, ...ids) {
	let commit;
	const committed = transaction({}, async (context) => {
		for (const id of ids) await T.put(id, { value: id }, context);
		await new Promise((resolve) => (commit = resolve));
	});
	await waitFor(() => commit);
	return () => {
		commit();
		return committed;
	};
}

function collector() {
	const events = [];
	const listener = (event) => events.push(event);
	listener.events = events;
	listener.values = () => events.map((event) => event.value?.value).filter((value) => value !== undefined);
	return listener;
}

function ownMembers(T) {
	return [[getThisNodeName(), getDatabaseGeneration(T.auditStore).id]];
}

function writeSeqRow(T, peerName, node) {
	const peerId = getIdOfRemoteNode(peerName, T.auditStore);
	T.dbisDB.putSync([SEQ, peerId], { seqId: 1, nodes: [{ id: peerId, ...node }] });
	return peerId;
}

/** Sends `end_txn` events for `[seq, routeId]` rows through T's database's real apply loop; resolves once each is recorded. */
function sourceFeed(T) {
	const pending = [];
	let wake;
	const Feed = table({
		table: `Feed${++sequence}`,
		database: T.databaseName,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Feed.sourcedFrom(
		{
			subscribeOnThisThread: () => true,
			async *subscribe() {
				yield { type: 'put', id: 'seed', value: { id: 'seed' }, timestamp: Date.now() };
				for (;;) {
					while (pending.length > 0) yield pending.shift();
					await new Promise((resolve) => (wake = resolve));
				}
			},
		},
		{ intermediateSource: true }
	);
	const txnStream = {};
	let localTime = Date.now();
	return (routeId, fields, originFloors) => {
		const event = {
			type: 'end_txn',
			localTime: ++localTime,
			timestamp: localTime,
			remoteNodeIds: [routeId],
			txnStream,
			onFailure: () => false,
			...fields,
		};
		if (originFloors) event.onCommit = () => (event.originFloors = originFloors);
		pending.push(event);
		wake?.();
		return waitFor(() => T.dbisDB.getSync([SEQ, routeId])?.seqId === event.localTime);
	};
}

describe('Per-origin subscription checkpoints (harper-pro#922 items 3–4)', function () {
	this.timeout(60_000);

	describe('encoding', () => {
		it('digests the member set independently of order', () => {
			const a = membersDigest([
				['n1', 'g1'],
				['n2', 'g2'],
			]);
			const b = membersDigest([
				['n2', 'g2'],
				['n1', 'g1'],
			]);
			assert.strictEqual(a, b);
			assert.notStrictEqual(a, membersDigest([['n1', 'g1']]));
			assert.notStrictEqual(
				a,
				membersDigest([
					['n1', 'g2'],
					['n2', 'g1'],
				])
			);
		});

		it('folds boundaries within the overlap into one common time and names a lagging origin as an exception', () => {
			const T = 1_790_000_000_000;
			const healthy = encodeCheckpoint(
				'scope',
				new Map([
					['a', { boundary: T, generation: 'ga' }],
					['b', { boundary: T - 30_000, generation: 'gb' }],
				])
			);
			assert.strictEqual(healthy.time, T);
			assert.strictEqual(healthy.overlap, 30_000);
			assert.deepStrictEqual(healthy.exceptions, {});
			assert.strictEqual(
				healthy.members,
				membersDigest([
					['a', 'ga'],
					['b', 'gb'],
				])
			);
			const lagging = encodeCheckpoint(
				'scope',
				new Map([
					['a', { boundary: T, generation: 'ga' }],
					['b', { boundary: T - 30_000, generation: 'gb' }],
					['c', { boundary: T - MAX_OVERLAP_MS - 1, generation: 'gc' }],
				])
			);
			assert.strictEqual(lagging.time, T);
			assert.strictEqual(lagging.overlap, MAX_OVERLAP_MS);
			assert.deepStrictEqual(lagging.exceptions, { c: T - MAX_OVERLAP_MS - 1 });
		});

		it('resolves membership exactly, through a late joiner the issuer never saw, and refuses otherwise', () => {
			const token = {
				v: 1,
				scope: 's',
				time: 10,
				overlap: 2,
				exceptions: { b: 5 },
				members: membersDigest([
					['a', 'ga'],
					['b', 'gb'],
				]),
			};
			const exact = resolveMembership(
				token,
				new Map([
					['a', 'ga'],
					['b', 'gb'],
				]),
				[]
			);
			assert.deepStrictEqual(
				[...exact.members],
				[
					['a', 8],
					['b', 5],
				]
			);
			assert.strictEqual(exact.excluded.size, 0);
			const joined = resolveMembership(
				token,
				new Map([
					['a', 'ga'],
					['b', 'gb'],
					['c', 'gc'],
				]),
				['c']
			);
			assert.deepStrictEqual([...joined.excluded], ['c']);
			assert.strictEqual(joined.members.size, 2);
			// the extra origin cannot be excluded, so the set does not match
			assert.strictEqual(
				resolveMembership(
					token,
					new Map([
						['a', 'ga'],
						['b', 'gb'],
						['c', 'gc'],
					]),
					[]
				),
				undefined
			);
			// a member is missing, or carries another generation
			assert.strictEqual(resolveMembership(token, new Map([['a', 'ga']]), ['a']), undefined);
			assert.strictEqual(
				resolveMembership(
					token,
					new Map([
						['a', 'ga'],
						['b', 'other'],
					]),
					[]
				),
				undefined
			);
		});

		it('refuses malformed checkpoints', () => {
			const good = { v: 1, scope: 's', time: 10, overlap: 2, exceptions: { b: 5 }, members: '0'.repeat(64) };
			assert.deepStrictEqual(validateCheckpoint(good), good);
			for (const bad of [
				null,
				[],
				{ ...good, v: 2 },
				{ ...good, scope: '' },
				{ ...good, time: -1 },
				{ ...good, overlap: 11 },
				{ ...good, members: 'xyz' },
				{ ...good, exceptions: { b: 9 } },
				{ ...good, exceptions: [] },
			]) {
				assert.throws(
					() => validateCheckpoint(bad),
					(error) => error.statusCode === 400
				);
			}
		});
	});

	describe('issuance and resume on RocksDB', function () {
		if (!isRocksDB) return;
		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			setOriginCaptureIntervalForTests(100);
		});

		it('issues a checkpoint once live that names no healthy origin', async () => {
			const T = tableInOwnDatabase();
			await T.put('seed', { value: 0 });
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			assert.strictEqual(checkpoint.v, 1);
			assert.deepStrictEqual(checkpoint.exceptions, {});
			assert.strictEqual(checkpoint.overlap, 0);
			assert.strictEqual(checkpoint.members, membersDigest(ownMembers(T)));
			assert.ok(Object.isFrozen(checkpoint));
			subscription.end();
		});

		it('resumes from a checkpoint and delivers only what follows it', async () => {
			const T = tableInOwnDatabase();
			const first = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener: first });
			await T.put('a', { value: 'a' });
			await waitFor(() => first.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			await T.put('b', { value: 'b' });
			await T.put('c', { value: 'c' });
			const second = collector();
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true, listener: second });
			assert.strictEqual(await resumed.resumeVerified, true);
			await waitFor(() => second.values().includes('c'));
			assert.deepStrictEqual(second.values(), ['b', 'c']);
			assert.strictEqual(resumed.ungated, true);
			resumed.end();
		});

		it('reports a resumed scalar progress below the lowest boundary, which is not yet delivered', async () => {
			const T = tableInOwnDatabase();
			const first = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener: first });
			await T.put('a', { value: 'a' });
			await waitFor(() => first.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true, listener: collector() });
			assert.strictEqual(await resumed.resumeVerified, true);
			const boundary = checkpoint.time - checkpoint.overlap;
			assert.ok(resumed.progress() <= positionBefore(boundary), 'the boundary key itself is not claimed');
			resumed.end();
		});

		it('keeps a transaction still open at the checkpoint below its boundary, so a resume delivers it', async () => {
			const T = tableInOwnDatabase();
			const first = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener: first });
			const commitLate = await heldTransaction(T, 'late');
			await T.put('early', { value: 'early' });
			await waitFor(() => first.values().includes('early'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			await commitLate();
			await T.put('after', { value: 'after' });
			const lateKey = [...T.auditStore.getRange({ start: 1 })].find((entry) => entry.recordId === 'late').txnLogKey;
			assert.ok(checkpoint.time - checkpoint.overlap <= lateKey, 'the boundary waited for the open transaction');
			const second = collector();
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true, listener: second });
			assert.strictEqual(await resumed.resumeVerified, true);
			await waitFor(() => second.values().includes('after'));
			assert.ok(second.values().includes('late'), 'the late lower-key transaction is delivered on resume');
			resumed.end();
		});

		it('delivers a transaction that commits below the checkpoint live, with no key gate', async () => {
			const T = tableInOwnDatabase();
			const first = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener: first });
			await T.put('a', { value: 'a' });
			await waitFor(() => first.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			const second = collector();
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true, listener: second });
			assert.strictEqual(await resumed.resumeVerified, true);
			const commitLate = await heldTransaction(T, 'late');
			await T.put('early', { value: 'early' });
			await waitFor(() => second.values().includes('early'));
			await commitLate();
			await waitFor(() => second.values().includes('late'));
			resumed.end();
		});

		it('holds an origin at an event handed to the queue but not yet taken', async () => {
			const T = tableInOwnDatabase();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
			await T.put('queued', { value: 'queued' });
			await waitFor(() => subscription.queue?.length >= 1);
			const key = subscription.queue[0].localTime;
			await sleep(2);
			certify(T);
			let held;
			await waitFor(() => (held = subscription.checkpoint()) !== undefined);
			assert.ok(held.time <= key, 'the boundary stays at the queued event');
			const iterator = subscription[Symbol.asyncIterator]();
			await iterator.next();
			await sleep(2);
			const floor = certify(T);
			let released;
			await waitFor(() => (released = subscription.checkpoint()) && released.time >= floor);
			assert.ok(released.time > key, 'the boundary passes the taken event');
			// a consumer's own hold lowers the boundary again
			const lowered = subscription.checkpoint(new Map([[0, key]]));
			assert.strictEqual(lowered.time, key);
			subscription.end();
		});

		it('delivers checkpoint events in band, only when a boundary advanced', async () => {
			const T = tableInOwnDatabase();
			const listener = collector();
			await assert.rejects(
				T.subscribe({ omitCurrent: true, reportProgress: true, checkpointInterval: 10 }),
				(error) => error.statusCode === 400
			);
			const subscription = await T.subscribe({
				omitCurrent: true,
				reportProgress: true,
				checkpointInterval: 1000,
				listener,
			});
			await T.put('a', { value: 'a' });
			certify(T);
			await waitFor(() => listener.events.some((event) => event.type === 'checkpoint'), 15_000);
			const event = listener.events.find((event) => event.type === 'checkpoint');
			assert.strictEqual(event.checkpoint.v, 1);
			subscription.end();
		});

		it('refuses another scope with 409, a malformed checkpoint with 400 and a foreign member set with 410', async () => {
			const T = tableInOwnDatabase();
			const Other = tableInOwnDatabase();
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			await assert.rejects(
				Other.subscribe({ resume: checkpoint, omitCurrent: true }),
				(error) => error.statusCode === 409
			);
			await assert.rejects(T.subscribe({ resume: { v: 1 }, omitCurrent: true }), (error) => error.statusCode === 400);
			await assert.rejects(
				T.subscribe({ resume: checkpoint, startTime: 1, omitCurrent: true }),
				(error) => error.statusCode === 400
			);
			const foreign = { ...checkpoint, members: membersDigest([['someone-else', 'g']]) };
			await assert.rejects(
				T.subscribe({ resume: foreign, omitCurrent: true }),
				(error) => error.statusCode === 410 && error.code === 'RESUME_HISTORY_UNAVAILABLE'
			);
			const otherGeneration = { ...checkpoint, members: membersDigest([[getThisNodeName(), 'f'.repeat(32)]]) };
			await assert.rejects(
				T.subscribe({ resume: otherGeneration, omitCurrent: true }),
				(error) => error.statusCode === 410
			);
		});

		it('admits an origin the issuer never saw only from its first retained entry', async () => {
			const T = tableInOwnDatabase();
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			subscription.end();
			const floor = certify(T);
			// a peer that joined after the checkpoint: its route here began at its first entry
			writeSeqRow(T, 'joined-later', {
				closedFloor: floor,
				originGeneration: 'joined-generation',
				fullCoverage: true,
				certifiedFrom: 0,
			});
			const resumed = await T.subscribe({ resume: checkpoint, omitCurrent: true, listener: collector() });
			assert.strictEqual(await resumed.resumeVerified, true);
			resumed.end();
			// its route began mid-history instead: nothing bounded can be replayed for it
			writeSeqRow(T, 'joined-later', {
				closedFloor: floor,
				originGeneration: 'joined-generation',
				fullCoverage: true,
				certifiedFrom: floor - 1000,
			});
			await assert.rejects(T.subscribe({ resume: checkpoint, omitCurrent: true }), (error) => error.statusCode === 410);
		});

		it('issues nothing on an engine that cannot sync the floor record before publishing it', async () => {
			const T = tableInOwnDatabase();
			const rootStore = T.primaryStore.rootStore;
			const syncWal = rootStore.syncWal;
			rootStore.syncWal = undefined;
			try {
				const listener = collector();
				const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
				await T.put('a', { value: 'a' });
				await waitFor(() => listener.values().includes('a'));
				await sleep(2);
				let floor = certifyOriginFloor(rootStore);
				for (let retry = 0; floor === null && retry < 100; retry++) floor = certifyOriginFloor(rootStore);
				persistOriginClosedFloor(T.auditStore, floor);
				publishOriginFloor(rootStore, floor);
				await sleep(400);
				await T.put('b', { value: 'b' });
				await waitFor(() => listener.values().includes('b'));
				await sleep(400);
				assert.strictEqual(subscription.checkpoint(), undefined, 'an unsynced floor certifies nothing');
				// the same steps with the sync available issue a token: the gate, not the timing, held it back
				rootStore.syncWal = syncWal ?? (() => Promise.resolve());
				await certifiedCheckpoint(T, subscription);
				subscription.end();
			} finally {
				rootStore.syncWal = syncWal;
			}
		});

		it('issues nothing while a known origin has no qualifying floor, and never from a revoked one', async () => {
			const T = tableInOwnDatabase();
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			const checkpoint = await certifiedCheckpoint(T, subscription);
			const floor = certify(T);
			// a level-1 certificate (no generation) from a legacy route
			writeSeqRow(T, 'legacy-peer', { closedFloor: floor, relayable: true });
			await sleep(400);
			await T.put('b', { value: 'b' });
			await waitFor(() => listener.values().includes('b'));
			await sleep(400);
			assert.strictEqual(subscription.checkpoint(), undefined, 'strict availability: no token without every floor');
			// the legacy peer certifies at level 2 now, so the token names both
			writeSeqRow(T, 'legacy-peer', {
				closedFloor: floor,
				originGeneration: 'peer-generation',
				fullCoverage: true,
				certifiedFrom: 0,
			});
			let both;
			await waitFor(() => (both = subscription.checkpoint()) !== undefined);
			assert.strictEqual(both.members, membersDigest([...ownMembers(T), ['legacy-peer', 'peer-generation']]));
			// a token naming a revoked origin is refused, since it may have written below its boundary
			writeSeqRow(T, 'legacy-peer', {
				floorRevoked: true,
				originGeneration: 'peer-generation',
				fullCoverage: true,
				certifiedFrom: 0,
			});
			await assert.rejects(T.subscribe({ resume: both, omitCurrent: true }), (error) => error.statusCode === 410);
			// an older token that never certified it is refused too: a revoked route cannot be shown whole
			await assert.rejects(T.subscribe({ resume: checkpoint, omitCurrent: true }), (error) => error.statusCode === 410);
			subscription.end();
		});
		it('refuses a route a copy bound covers, certifies nothing under it, and admits once the route starts above it', async () => {
			const T = tableInOwnDatabase();
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			await sleep(2);
			const floor = certify(T);
			const route = { closedFloor: floor, originGeneration: 'copied-generation', fullCoverage: true };
			const peerId = writeSeqRow(T, 'copied-peer', { ...route, certifiedFrom: floor - 1000 });
			const members = membersDigest([...ownMembers(T), ['copied-peer', 'copied-generation']]);
			let token;
			await waitFor(() => (token = subscription.checkpoint())?.members === members);
			const resumed = await T.subscribe({ resume: token, omitCurrent: true, listener: collector() });
			assert.strictEqual(await resumed.resumeVerified, true);
			resumed.end();
			const rootStore = T.primaryStore.rootStore;
			await writeCopyBounds(rootStore, 77, { raise: new Map([[peerId, floor - 1000]]) });
			assert.strictEqual(subscription.checkpoint(), undefined, 'a capture from before the bound is not used');
			await assert.rejects(T.subscribe({ resume: token, omitCurrent: true }), (error) => error.statusCode === 410);
			await sleep(400);
			assert.strictEqual(subscription.checkpoint(), undefined, 'no capture qualifies the covered route');
			writeSeqRow(T, 'copied-peer', { ...route, certifiedFrom: floor - 999 });
			const again = await T.subscribe({ resume: token, omitCurrent: true, listener: collector() });
			assert.strictEqual(await again.resumeVerified, true);
			again.end();
			await waitFor(() => subscription.checkpoint()?.members === members);
			// a copy that restored this node's own lost rows: its own log is complete only above them
			await writeCopyBounds(rootStore, 79, { raise: new Map([[0, floor - 100_000]]) });
			const belowOwn = await T.subscribe({ resume: token, omitCurrent: true, listener: collector() });
			assert.strictEqual(await belowOwn.resumeVerified, true);
			belowOwn.end();
			await writeCopyBounds(rootStore, 79, { raise: new Map([[0, floor]]) });
			await assert.rejects(T.subscribe({ resume: token, omitCurrent: true }), (error) => error.statusCode === 410);
			await sleep(400);
			assert.strictEqual(subscription.checkpoint(), undefined, 'no capture while the own floor is below its start');
			await writeCopyBounds(rootStore, 79, { release: [[]] });
			for (const malformed of [
				{ [peerId]: 'not a version' },
				{ [peerId]: -1 },
				{ '': floor },
				{ '-1': floor },
				{ '01': floor },
				[floor],
			]) {
				T.dbisDB.putSync([COPY_BOUND_KEY, 78], malformed);
				await assert.rejects(
					T.subscribe({ resume: token, omitCurrent: true }),
					(error) => error.statusCode === 410,
					`fails closed on ${JSON.stringify(malformed)}`
				);
			}
			subscription.end();
		});

		it('drops a replay a copy bound voids while it is still running', async () => {
			const T = tableInOwnDatabase();
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			await sleep(2);
			const floor = certify(T);
			const peerId = writeSeqRow(T, 'replayed-peer', {
				closedFloor: floor,
				originGeneration: 'replayed-generation',
				fullCoverage: true,
				certifiedFrom: floor - 1000,
			});
			const members = membersDigest([...ownMembers(T), ['replayed-peer', 'replayed-generation']]);
			let token;
			await waitFor(() => (token = subscription.checkpoint())?.members === members);
			subscription.end();
			for (let i = 0; i < 250; i++) await T.put(`r${i}`, { value: i });
			// no listener: the replay stops at the queue's high-water mark until it is drained
			const resumed = await T.subscribe({ resume: token, omitCurrent: true });
			await waitFor(() => resumed.queue?.length > 100);
			await writeCopyBounds(T.primaryStore.rootStore, 80, { raise: new Map([[peerId, floor - 1000]]) });
			resumed.on('data', () => {});
			assert.strictEqual(await resumed.resumeVerified, false);
		});

		it('drops a replay once an origin it never accounted for joins a seq row', async () => {
			const T = tableInOwnDatabase();
			const listener = collector();
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
			await T.put('a', { value: 'a' });
			await waitFor(() => listener.values().includes('a'));
			const token = await certifiedCheckpoint(T, subscription);
			subscription.end();
			for (let i = 0; i < 250; i++) await T.put(`r${i}`, { value: i });
			const send = sourceFeed(T);
			const resumed = await T.subscribe({ resume: token, omitCurrent: true });
			await waitFor(() => resumed.queue?.length > 100);
			const joined = getIdOfRemoteNode('joined-mid-replay', T.auditStore);
			await send(joined, {}, [[joined, certify(T), true]]);
			resumed.on('data', () => {});
			assert.strictEqual(await resumed.resumeVerified, false);
		});

		it('writes copy bounds in one commit per change and bumps the epoch on every call, or writes nothing', async () => {
			const T = tableInOwnDatabase();
			const rootStore = T.primaryStore.rootStore;
			const row = (...key) => {
				const value = T.dbisDB.getSync([COPY_BOUND_KEY, ...key]);
				return value && typeof value === 'object' ? { ...value } : value;
			};
			let epoch = readOriginStateEpoch(rootStore);
			const bumped = () => {
				const previous = epoch;
				epoch = readOriginStateEpoch(rootStore);
				return epoch > previous;
			};
			assert.strictEqual(await writeCopyBounds(rootStore, 7, { raise: new Map([[3, 500]]) }), true);
			assert.deepStrictEqual(row(7), { 3: 500 });
			assert.ok(bumped());
			assert.strictEqual(await writeCopyBounds(rootStore, 7, { raise: new Map([[3, 400]]) }), false);
			assert.deepStrictEqual(row(7), { 3: 500 });
			assert.ok(bumped());
			await writeCopyBounds(rootStore, 7, { raise: new Map([[4, 900]]), at: ['reserved', 1] });
			assert.deepStrictEqual(
				readCopyBounds(T.dbisDB),
				new Map([
					[3, 500],
					[4, 900],
				])
			);
			await writeCopyBounds(rootStore, 7, { raise: new Map([[4, 700]]), release: [['reserved', 1]] });
			assert.strictEqual(row(7, 'reserved', 1), undefined);
			assert.deepStrictEqual(
				readCopyBounds(T.dbisDB),
				new Map([
					[3, 500],
					[4, 700],
				])
			);
			await Promise.all(
				[600, 800, 650].map((bound) => writeCopyBounds(rootStore, 7, { raise: new Map([[5, bound]]) }))
			);
			assert.strictEqual(row(7)[5], 800);
			bumped();
			await assert.rejects(writeCopyBounds({ dbisDb: T.dbisDB }, 8, { raise: new Map([[3, 1]]) }), /epoch/);
			assert.strictEqual(row(8), undefined);
			for (const invalid of [new Map([[3, -1]]), new Map([[3, NaN]]), new Map([[-1, 1]]), new Map([[1.5, 1]])]) {
				await assert.rejects(writeCopyBounds(rootStore, 7, { raise: invalid }), /Invalid copy bound/);
			}
			await assert.rejects(
				writeCopyBounds(rootStore, 7, { raise: new Map([[3, 900]]), at: ['s'], release: [['s']] }),
				/same row/
			);
			// an empty raise raises nothing, so it may release the row it names
			await writeCopyBounds(rootStore, 7, { raise: new Map([[3, 900]]), at: ['s'] });
			assert.strictEqual(await writeCopyBounds(rootStore, 7, { raise: new Map(), at: ['s'], release: [['s']] }), true);
			assert.strictEqual(row(7, 's'), undefined);
			assert.ok(bumped());
			T.dbisDB.putSync([COPY_BOUND_KEY, 9], { 3: 'not a version' });
			await assert.rejects(
				writeCopyBounds(rootStore, 9, { raise: new Map([[3, 1]]) }),
				(error) => error.statusCode === 410
			);
			assert.deepStrictEqual(row(9), { 3: 'not a version' });
			const suspension = suspendDatabaseCommits([rootStore]);
			try {
				await assert.rejects(writeCopyBounds(rootStore, 7, { raise: new Map([[6, 1]]) }));
			} finally {
				suspension.release();
			}
			assert.strictEqual(row(7)[6], undefined);
			assert.ok(!bumped());
			// a release reads no bound, so it clears a malformed row; the lock was released by every refusal
			await writeCopyBounds(rootStore, 9, { release: [[]] });
			assert.strictEqual(row(9), undefined);
			assert.strictEqual(await writeCopyBounds(rootStore, 7, { raise: new Map([[6, 1]]) }), true);
		});

		describe('an origin two routes certify under different generations', () => {
			const g1 = '1'.repeat(32);
			const g2 = '2'.repeat(32);
			const g3 = '3'.repeat(32);
			const admits = async (T, token) => {
				const resumed = await T.subscribe({ resume: token, omitCurrent: true, listener: collector() });
				const verified = await resumed.resumeVerified;
				resumed.end();
				return verified;
			};
			const refuses = (T, token, message) =>
				assert.rejects(T.subscribe({ resume: token, omitCurrent: true }), (error) => error.statusCode === 410, message);

			/** A token naming `${name}-origin` under g1, certified by the `retained` route's g1 row alone. */
			async function issueG1Token(name) {
				const T = tableInOwnDatabase();
				const listener = collector();
				const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
				await T.put('a', { value: 'a' });
				await waitFor(() => listener.values().includes('a'));
				await sleep(2);
				const floor = certify(T);
				const origin = getIdOfRemoteNode(`${name}-origin`, T.auditStore);
				const retained = getIdOfRemoteNode(`${name}-retained`, T.auditStore);
				const live = getIdOfRemoteNode(`${name}-live`, T.auditStore);
				assert.ok(origin < retained && retained < live);
				const route = (routeId, node) =>
					T.dbisDB.putSync([SEQ, routeId], { seqId: 1, nodes: [{ id: origin, ...node }] });
				// the origin's g1 clock ran ahead of the host its g2 restore landed on
				const healthy = (generation, closedFloor, replacedGenerations) => ({
					closedFloor,
					originGeneration: generation,
					fullCoverage: true,
					certifiedFrom: floor - 1000,
					replacedGenerations,
				});
				route(retained, healthy(g1, floor + 100));
				const members = (generation) => membersDigest([...ownMembers(T), [`${name}-origin`, generation]]);
				let token;
				await waitFor(() => (token = subscription.checkpoint())?.members === members(g1));
				assert.strictEqual(await admits(T, token), true);
				return { T, subscription, floor, origin, retained, live, route, healthy, members, token };
			}

			it('refuses a token issued before an origin it now knows without a single certified generation', async () => {
				const T = tableInOwnDatabase();
				const listener = collector();
				const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
				await T.put('a', { value: 'a' });
				await waitFor(() => listener.values().includes('a'));
				const token = await certifiedCheckpoint(T, subscription);
				subscription.end();
				const floor = certify(T);
				// a copy can write an origin's rows with no log here, so only its seq-row entries say it is known
				const origin = getIdOfRemoteNode('later-origin', T.auditStore);
				const first = getIdOfRemoteNode('later-first', T.auditStore);
				const second = getIdOfRemoteNode('later-second', T.auditStore);
				const route = (routeId, node) =>
					T.dbisDB.putSync([SEQ, routeId], { seqId: 1, nodes: [{ id: origin, ...node }] });
				const healthy = (generation) => ({
					closedFloor: floor,
					originGeneration: generation,
					fullCoverage: true,
					certifiedFrom: floor - 1000,
				});
				route(first, healthy(g1));
				route(second, healthy(g2));
				await refuses(T, token, 'unordered generations');
				T.dbisDB.removeSync([SEQ, second]);
				route(first, { closedFloor: floor, relayable: true });
				await refuses(T, token, 'a level-1 route alone');
				T.dbisDB.removeSync([SEQ, first]);
				assert.strictEqual(await admits(T, token), true);
			});

			it('fails closed when nothing shows which replaced the other, whichever floor is higher', async () => {
				const { T, subscription, floor, retained, live, route, healthy, token } = await issueG1Token('unordered');
				const revokedG2 = { originGeneration: g2, floorRevoked: true };
				route(live, revokedG2);
				await refuses(T, token, 'a revoked g2 row after the healthy g1 row');
				route(retained, revokedG2);
				route(live, healthy(g1, floor + 100));
				await refuses(T, token, 'a revoked g2 row before the healthy g1 row');
				route(retained, healthy(g2, floor + 100));
				await refuses(T, token, 'equal floors');
				route(retained, healthy(g2, floor, [g1]));
				await refuses(T, token, 'a relayed route that saw g1 replaced');
				await sleep(400);
				assert.strictEqual(subscription.checkpoint(), undefined, 'no capture names either generation');
				route(retained, healthy(g1, floor + 100));
				route(live, { closedFloor: floor + 200, lastGeneration: g2 });
				await refuses(T, token, 'a relay that certified g2 before it dropped to level 1');
				T.dbisDB.removeSync([SEQ, live]);
				assert.strictEqual(await admits(T, token), true);
				subscription.end();
			});

			it('takes the generation the direct route saw replace every other, and fails closed on a contradiction', async () => {
				const { T, subscription, floor, origin, retained, live, route, healthy, members, token } =
					await issueG1Token('witnessed');
				route(origin, { originGeneration: g2, floorRevoked: true, replacedGenerations: [g1] });
				await refuses(T, token, "g2's revocation counts though g1's floor is higher");
				route(origin, healthy(g2, floor, [g1]));
				await refuses(T, token, 'g1 is replaced');
				let g2Token;
				await waitFor(() => (g2Token = subscription.checkpoint())?.members === members(g2));
				assert.strictEqual(await admits(T, g2Token), true);
				route(live, healthy(g3, floor));
				await refuses(T, g2Token, 'an unwitnessed third generation');
				route(origin, healthy(g2, floor, [g3, g1]));
				assert.strictEqual(await admits(T, g2Token), true);
				route(origin, healthy(g2, floor, [g1, g3, g2]));
				await refuses(T, g2Token, 'a reversal');
				T.dbisDB.removeSync([SEQ, live]);
				T.dbisDB.removeSync([SEQ, retained]);
				await refuses(T, g2Token, 'a reversal with no other row');
				route(origin, healthy(g2, floor));
				assert.strictEqual(await admits(T, g2Token), true, 'one generation needs no witness');
				// the direct route dropped to level 1 after seeing g1 replaced: a retained g1 row stays replaced
				route(origin, { closedFloor: floor, lastGeneration: g2, replacedGenerations: [g1] });
				route(retained, healthy(g1, floor + 100));
				await refuses(T, token, 'g1 is replaced while the direct route certifies at level 1');
				route(retained, healthy(g2, floor));
				assert.strictEqual(await admits(T, g2Token), true);
				route(origin, { closedFloor: floor, lastGeneration: g2, replacedGenerations: [g1], hole: true });
				await refuses(T, g2Token, 'a hole the direct route recorded under g2 counts after it dropped to level 1');
				subscription.end();
			});

			it('orders a restore whose clock is behind through certificates the apply loop records', async () => {
				const T = tableInOwnDatabase();
				const listener = collector();
				const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true, listener });
				await T.put('a', { value: 'a' });
				await waitFor(() => listener.values().includes('a'));
				await sleep(2);
				const floor = certify(T);
				const origin = getIdOfRemoteNode('restored-origin', T.auditStore);
				const relay = getIdOfRemoteNode('restored-relay', T.auditStore);
				const send = sourceFeed(T);
				const certifyRoute = async (routeId, generation, closedFloor) => {
					await send(routeId, {}, [[origin, closedFloor, true, generation, true]]);
					await send(routeId, { originRouteStates: [[origin, floor - 1000, undefined, undefined, generation]] });
				};
				const members = (generation) => membersDigest([...ownMembers(T), ['restored-origin', generation]]);
				await certifyRoute(origin, g1, floor + 100);
				await certifyRoute(relay, g1, floor + 100);
				let token;
				await waitFor(() => (token = subscription.checkpoint())?.members === members(g1));
				assert.strictEqual(await admits(T, token), true);
				await certifyRoute(origin, g2, floor);
				await refuses(T, token, 'the relay still holds g1 at a higher floor');
				assert.deepStrictEqual(T.dbisDB.getSync([SEQ, origin]).nodes[0].replacedGenerations, [g1]);
				let g2Token;
				await waitFor(() => (g2Token = subscription.checkpoint())?.members === members(g2));
				assert.strictEqual(await admits(T, g2Token), true);
				const rootStore = T.primaryStore.rootStore;
				await writeCopyBounds(rootStore, relay, { raise: new Map([[origin, floor - 1000]]) });
				await refuses(T, g2Token, 'a copy bound covers the g2 route');
				await writeCopyBounds(rootStore, relay, { release: [[]] });
				assert.strictEqual(await admits(T, g2Token), true);
				await send(origin, { originFloorRevocations: [[origin, g2]] });
				await refuses(T, g2Token, "g2's revocation is not hidden by g1's higher floor");
				subscription.end();
			});
		});
	});

	describe('on LMDB', () => {
		if (isRocksDB) return;
		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
		});
		it('refuses a checkpoint resume with 409 and issues none', async () => {
			const T = tableInOwnDatabase();
			const token = { v: 1, scope: 's', time: 10, overlap: 0, exceptions: {}, members: '0'.repeat(64) };
			await assert.rejects(T.subscribe({ resume: token, omitCurrent: true }), (error) => error.statusCode === 409);
			const subscription = await T.subscribe({ omitCurrent: true, reportProgress: true });
			assert.strictEqual(subscription.checkpoint, undefined);
			subscription.end();
		});
		it('writes copy bounds in one transaction and bumps the epoch', async () => {
			const T = tableInOwnDatabase();
			const rootStore = T.primaryStore.rootStore;
			const before = readOriginStateEpoch(rootStore);
			assert.strictEqual(
				await writeCopyBounds(rootStore, 7, { raise: new Map([[3, 500]]), at: ['reserved', 1] }),
				true
			);
			assert.strictEqual(
				await writeCopyBounds(rootStore, 7, { raise: new Map([[3, 400]]), release: [['reserved', 1]] }),
				true
			);
			assert.deepStrictEqual(readCopyBounds(T.dbisDB), new Map([[3, 400]]));
			assert.strictEqual(await writeCopyBounds(rootStore, 7, { raise: new Map([[3, 300]]) }), false);
			assert.strictEqual(readOriginStateEpoch(rootStore), before + 3);
			// inside another write transaction, which would commit or abort the bound with it, or wait on it
			const refusal = (promise) =>
				promise.then(
					() => undefined,
					(error) => error
				);
			let nested;
			rootStore.transactionSync(() => {
				nested = refusal(writeCopyBounds(rootStore, 7, { raise: new Map([[3, 900]]) }));
			});
			assert.ok((await nested) instanceof Error);
			await rootStore.transactionAsync(() => {
				nested = refusal(writeCopyBounds(rootStore, 7, { raise: new Map([[3, 900]]) }));
			});
			assert.ok((await nested) instanceof Error);
			assert.deepStrictEqual(readCopyBounds(T.dbisDB), new Map([[3, 400]]));
			assert.strictEqual(readOriginStateEpoch(rootStore), before + 3);
		});
	});
});
