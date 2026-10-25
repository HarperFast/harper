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
	MAX_OVERLAP_MS,
	encodeCheckpoint,
	membersDigest,
	positionBefore,
	resolveMembership,
	validateCheckpoint,
} = require('#src/resources/subscriptionCheckpoint');
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
	});
});
