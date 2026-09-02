const assert = require('assert');
const { Worker } = require('worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { LOCAL_ONLY } = require('#src/resources/auditStore');
const { LOCKED } = require('#src/resources/recordLock');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Exclusive record locks (harper#483, Phase 0): the durable, version-conditional LOCK write is the
// only authority, so every assertion here reads the record's own metadata and audit trail.
describe('Record locks (harper#483)', () => {
	let LockTest;
	let nextId = 1;
	const id = () => `lock-${nextId++}`;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		LockTest = table({
			table: 'RecordLockTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }, { name: 'name' }],
		});
	});

	const entryOf = (recordId) => LockTest.primaryStore.getEntry(recordId);
	const isLocked = (recordId) => Boolean(entryOf(recordId)?.metadataFlags & LOCKED);
	function auditTrail(recordId) {
		const trail = [];
		for (const entry of LockTest.auditStore.getRange({ start: 1 })) {
			if (entry.tableId === LockTest.tableId && entry.recordId === recordId) trail.push(entry);
		}
		return trail;
	}
	/** 'pending' when `promise` has not settled within `ms`, else 'settled'. */
	const settlement = (promise, ms = 150) =>
		Promise.race([
			promise.then(
				() => 'settled',
				() => 'settled'
			),
			delay(ms).then(() => 'pending'),
		]);

	describe('durable lock state', () => {
		it('a held lock sets LOCKED with a generation and unlock clears it, each as a version-changing local-only audit entry', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'one' });
			const before = entryOf(recordId);
			const record = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			const locked = entryOf(recordId);
			assert.ok(locked.metadataFlags & LOCKED, 'LOCKED is set');
			assert.ok(locked.version > before.version, 'LOCK bumped the record version');
			assert.strictEqual(locked.lockVersion, locked.version, 'the lock generation is the LOCK version');
			assert.ok(locked.lockExpiresAt > Date.now() && locked.lockExpiresAt <= Date.now() + 5000, 'lease deadline');
			assert.deepStrictEqual({ ...locked.value }, { id: recordId, n: 1, name: 'one' }, 'value untouched');
			assert.strictEqual(record.getProperty('name'), 'one', 'the returned record is loaded');

			assert.strictEqual(await record.unlock(), true);
			const unlocked = entryOf(recordId);
			assert.strictEqual(unlocked.metadataFlags & LOCKED, 0, 'LOCKED cleared');
			assert.strictEqual(unlocked.lockVersion, undefined);
			assert.ok(unlocked.version > locked.version, 'UNLOCK bumped the record version');
			assert.deepStrictEqual({ ...unlocked.value }, { id: recordId, n: 1, name: 'one' }, 'value survives');

			const trail = auditTrail(recordId).map((entry) => ({
				type: entry.type,
				version: entry.version,
				localOnly: Boolean(entry.extendedType & LOCAL_ONLY),
				body: entry.getValue(LockTest.primaryStore),
			}));
			const lockEntry = trail.find((entry) => entry.type === 'lock');
			const unlockEntry = trail.find((entry) => entry.type === 'unlock');
			assert.ok(lockEntry && unlockEntry, `lock and unlock entries are in the audit log: ${JSON.stringify(trail)}`);
			assert.strictEqual(lockEntry.version, locked.version);
			assert.strictEqual(unlockEntry.version, unlocked.version);
			assert.ok(lockEntry.localOnly && unlockEntry.localOnly, 'both are LOCAL_ONLY');
			assert.strictEqual(lockEntry.body, undefined, 'header-only');
			assert.strictEqual(unlockEntry.body, undefined, 'header-only');
			assert.strictEqual(await record.unlock(), false, 'a second unlock has nothing to clear');
		});

		it('keeps a record TTL across lock and unlock', async () => {
			const recordId = id();
			const expiresAt = Date.now() + 600000;
			await LockTest.put({ id: recordId, n: 1 }, { expiresAt });
			const record = await LockTest.lock(recordId, { hold: true });
			assert.strictEqual(entryOf(recordId).expiresAt, expiresAt);
			await record.unlock();
			assert.strictEqual(entryOf(recordId).expiresAt, expiresAt);
		});

		it('validates its options', async () => {
			const recordId = id();
			for (const options of [
				{ lease: -1 },
				{ lease: 5 },
				{ lease: 'soon' },
				{ timeout: 0 },
				{ lease: 10e6 },
				{ hold: 'yes' },
			]) {
				await assert.rejects(
					async () => LockTest.lock(recordId, options),
					(error) => error.statusCode === 400
				);
			}
		});

		it('needs a transaction unless the lock is held', async () => {
			await assert.rejects(
				async () => LockTest.lock(id()),
				(error) => error.statusCode === 400 && /hold/.test(error.message)
			);
		});
	});

	describe('transaction scope', () => {
		it('releases at commit, after the holder wrote through the returned record', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			let lockedInside;
			await transaction(async () => {
				const record = await LockTest.lock(recordId);
				lockedInside = isLocked(recordId);
				record.set('n', record.getProperty('n') + 1);
				await record.save();
			});
			assert.strictEqual(lockedInside, true);
			assert.strictEqual(isLocked(recordId), false, 'released at commit');
			assert.strictEqual((await LockTest.get(recordId)).n, 2);
		});

		it('releases on abort and the write is rolled back', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			await assert.rejects(
				transaction(async () => {
					const record = await LockTest.lock(recordId);
					record.set('n', 5);
					await record.save();
					throw new Error('abandon');
				}),
				/abandon/
			);
			assert.strictEqual(isLocked(recordId), false, 'released at abort');
			assert.strictEqual((await LockTest.get(recordId)).n, 1);
		});

		it('is re-entrant within the transaction and lets the static verbs write', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			await transaction(async () => {
				const first = await LockTest.lock(recordId);
				const generation = entryOf(recordId).lockVersion;
				await LockTest.lock(recordId);
				assert.strictEqual(entryOf(recordId).lockVersion, generation, 'one generation');
				await LockTest.patch(recordId, { name: 'patched' });
				assert.ok(first);
			});
			assert.strictEqual(isLocked(recordId), false);
			assert.strictEqual((await LockTest.get(recordId)).name, 'patched');
		});

		it('re-stages a holder write past an ungated rewrite that moved the record during the critical section', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'start' });
			let movedVersion;
			await transaction(async () => {
				const record = await LockTest.lock(recordId);
				// a canonical-source apply is never gated; it carries the generation forward and bumps the version
				await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 50, name: 'source' }));
				movedVersion = entryOf(recordId).version;
				assert.ok(entryOf(recordId).lockVersion, 'the source apply kept the lock');
				record.set('n', 7);
				await record.save();
			});
			const final = entryOf(recordId);
			assert.strictEqual(final.value.n, 7, 'the holder write is not lost below the moved version');
			assert.ok(final.version > movedVersion, 'and landed as the newest version');
			assert.strictEqual(isLocked(recordId), false);
		});

		it('must be acquired before the transaction writes', async () => {
			const recordId = id();
			await assert.rejects(
				transaction(async () => {
					await LockTest.put({ id: recordId, n: 1 });
					await LockTest.lock(recordId);
				}),
				(error) => error.statusCode === 400 && /before/.test(error.message)
			);
		});
	});

	describe('write gate', () => {
		it('delays a non-holder put until the release, then applies it without losing the holder write', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'start' });
			const holder = await LockTest.lock(recordId, { hold: true });
			const put = LockTest.put({ id: recordId, n: 10, name: 'later' });
			assert.strictEqual(await settlement(put), 'pending', 'the put waits for the lock');
			holder.set('n', 2);
			await holder.save();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'the holder writes through');
			assert.strictEqual(await settlement(put, 50), 'pending', 'still waiting');
			await holder.unlock();
			await put;
			const final = await LockTest.get(recordId);
			assert.deepStrictEqual(
				{ n: final.n, name: final.name },
				{ n: 10, name: 'later' },
				'the delayed put applied after the holder'
			);
			assert.strictEqual(isLocked(recordId), false);
			const types = auditTrail(recordId).map((entry) => entry.type);
			assert.ok(types.includes('lock') && types.includes('unlock'), `audit trail ${types}`);
			assert.ok(types.indexOf('unlock') < types.lastIndexOf('put'), 'the delayed put is audited after the unlock');
		});

		it('gates a delete and an update too', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const holder = await LockTest.lock(recordId, { hold: true });
			const deletion = LockTest.delete(recordId);
			assert.strictEqual(await settlement(deletion), 'pending');
			await holder.unlock();
			await deletion;
			assert.ok((await LockTest.get(recordId)) == null, 'deleted after the release');
		});

		it('gates the creation of a locked absent id (locked placeholder)', async () => {
			const recordId = id();
			const holder = await LockTest.lock(recordId, { hold: true });
			assert.ok((await LockTest.get(recordId)) == null, 'the placeholder is invisible');
			assert.ok(isLocked(recordId), 'but the id carries the generation');
			const creation = LockTest.create({ id: recordId, n: 1 });
			assert.strictEqual(await settlement(creation), 'pending');
			holder.set('n', 100);
			await holder.save();
			assert.strictEqual((await LockTest.get(recordId)).n, 100, 'the holder created it');
			await holder.unlock();
			await creation;
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'then the delayed create applied');
		});

		it('gates a non-holder publish; a holder publish and invalidate keep the generation', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const holder = await LockTest.lock(recordId, { hold: true });
			const generation = entryOf(recordId).lockVersion;
			const published = LockTest.publish(recordId, { hello: 'world' });
			assert.strictEqual(await settlement(published), 'pending', 'a message rewrites the version, so it waits');
			await holder.publish({ hello: 'holder' });
			assert.strictEqual(entryOf(recordId).lockVersion, generation, 'the holder publish preserved the lock');
			await holder.invalidate();
			assert.strictEqual(entryOf(recordId).lockVersion, generation, 'invalidate preserved the lock');
			await holder.unlock();
			await published;
			assert.strictEqual(isLocked(recordId), false);
		});

		it('gates a numeric id 0 (a valid key that is falsy)', async function () {
			if (isLMDB) this.skip(); // LMDB does not store key 0 at all today (pre-existing)
			await LockTest.put({ id: 0, n: 1 });
			const holder = await LockTest.lock(0, { hold: true });
			const put = LockTest.put({ id: 0, n: 2 });
			assert.strictEqual(await settlement(put), 'pending');
			await holder.unlock();
			await put;
			assert.strictEqual((await LockTest.get(0)).n, 2);
		});

		it('a holder delete on an unaudited table leaves a locked tombstone, so the lock outlives the row', async function () {
			// LMDB's immediate transaction only commits eager instance writes through save(); a bare
			// instance delete() outside a scope stays staged there (pre-existing), so RocksDB only
			if (isLMDB) this.skip();
			const NoAudit = table({
				table: 'RecordLockNoAudit',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				audit: false,
				trackDeletes: false,
			});
			const recordId = id();
			await NoAudit.put({ id: recordId, n: 1 });
			const holder = await NoAudit.lock(recordId, { hold: true });
			await holder.delete(); // the instance delete resolves before its immediate commit lands
			const tombstone = await waitFor(
				() => {
					const entry = NoAudit.primaryStore.getEntry(recordId);
					return entry && entry.value == null && entry;
				},
				{ message: 'the row is gone' }
			);
			assert.ok(tombstone.metadataFlags & LOCKED, 'but the generation stays on a tombstone');
			const put = NoAudit.put({ id: recordId, n: 2 });
			assert.strictEqual(await settlement(put), 'pending', 'so a re-create still waits for the holder');
			await holder.unlock();
			await put;
			assert.strictEqual((await NoAudit.get(recordId)).n, 2);
		});

		it("lock and unlock carry the record's out-of-order audit refs forward", async function () {
			if (isLMDB) this.skip(); // additionalAuditRefs are a RocksDB dedup guard
			const recordId = id();
			const now = Date.now();
			await LockTest.put({ id: recordId, n: 1, name: 'first' }, { timestamp: now - 3000 });
			await LockTest.patch(recordId, { name: 'newer' }, { timestamp: now - 1000 });
			await LockTest.patch(recordId, { n: 2 }, { timestamp: now - 2000 }); // out of order under the newer patch
			const refs = entryOf(recordId).additionalAuditRefs;
			assert.ok(refs?.length > 0, `the out-of-order patch left a ref: ${JSON.stringify(refs)}`);
			const holder = await LockTest.lock(recordId, { hold: true });
			assert.deepStrictEqual(entryOf(recordId).additionalAuditRefs, refs, 'kept by LOCK');
			await holder.unlock();
			assert.deepStrictEqual(entryOf(recordId).additionalAuditRefs, refs, 'kept by UNLOCK');
		});

		it('fails a waiting lock with 423 at its timeout', async () => {
			const recordId = id();
			const holder = await LockTest.lock(recordId, { hold: true });
			await assert.rejects(
				transaction(() => LockTest.lock(recordId, { timeout: 150 })),
				(error) => error.statusCode === 423
			);
			await holder.unlock();
		});
	});

	describe('lease', () => {
		it('expires an abandoned lock: the record survives, a waiter proceeds, and the old holder has lost it', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'keep' });
			const abandoned = await LockTest.lock(recordId, { hold: true, lease: 300 });
			const started = Date.now();
			const waiter = transaction(async () => {
				const record = await LockTest.lock(recordId, { timeout: 5000 });
				record.set('n', 2);
				await record.save();
				return Date.now();
			});
			const acquiredAt = await waiter;
			assert.ok(acquiredAt - started >= 250, `the waiter proceeded only after the lease (${acquiredAt - started}ms)`);
			const entry = entryOf(recordId);
			assert.deepStrictEqual(
				{ n: entry.value.n, name: entry.value.name },
				{ n: 2, name: 'keep' },
				'record and value survive'
			);
			assert.strictEqual(isLocked(recordId), false, 'the takeover generation was released at commit');
			assert.strictEqual(await abandoned.unlock(), false, 'the expired holder cannot clear a later generation');
		});

		it('an expired holder write fails with 409 while another party holds the record', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const stale = await LockTest.lock(recordId, { hold: true, lease: 200 });
			await delay(250);
			const current = await LockTest.lock(recordId, { hold: true });
			stale.set('n', 99);
			await assert.rejects(
				async () => stale.save(),
				(error) => error.statusCode === 409
			);
			await current.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 1);
		});

		it('a plain write after the lease clears the bit', async () => {
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			await LockTest.lock(recordId, { hold: true, lease: 200 });
			const started = Date.now();
			await LockTest.put({ id: recordId, n: 3 });
			assert.ok(Date.now() - started >= 150, 'the put waited for the lease');
			assert.strictEqual(isLocked(recordId), false);
			assert.strictEqual((await LockTest.get(recordId)).n, 3);
		});
	});

	describe('across worker threads', function () {
		let workers = [];
		const workerCount = 3;
		const request = (worker, message, replyType) =>
			new Promise((resolve, reject) => {
				const onMessage = (reply) => {
					if (reply.type === 'error') {
						worker.off('message', onMessage);
						reject(Object.assign(new Error(reply.message), { statusCode: reply.statusCode, stack: reply.stack }));
					} else if (reply.type === replyType) {
						worker.off('message', onMessage);
						resolve(reply);
					}
				};
				worker.on('message', onMessage);
				worker.postMessage(message);
			});
		let ThreadTable;
		before(async function () {
			ThreadTable = table({
				table: 'RecordLockThread',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
			});
			for (let i = 0; i < workerCount; i++) {
				workers.push(new Worker(__dirname + '/recordLock-thread.js', { workerData: { addPorts: [] } }));
			}
		});
		after(async function () {
			for (const worker of workers) worker.postMessage({ type: 'shutdown' });
			workers = [];
		});

		it('a lock held on another thread gates this thread until it is released', async function () {
			const recordId = id();
			await ThreadTable.put({ id: recordId, n: 1 });
			await request(workers[0], { type: 'hold', id: recordId, lease: 5000 }, 'held');
			assert.ok(Boolean(ThreadTable.primaryStore.getEntry(recordId).metadataFlags & LOCKED));
			await assert.rejects(
				transaction(() => ThreadTable.lock(recordId, { timeout: 150 })),
				(error) => error.statusCode === 423
			);
			const put = ThreadTable.put({ id: recordId, n: 2 });
			assert.strictEqual(await settlement(put), 'pending');
			const released = await request(workers[0], { type: 'release' }, 'released');
			assert.strictEqual(released.cleared, true);
			await put;
			assert.strictEqual((await ThreadTable.get(recordId)).n, 2);
		});

		it('serializes increments from every thread: exact count, no overlapping holders', async function () {
			const recordId = id();
			const perWorker = isLMDB ? 5 : 15;
			const runs = workers.map((worker) =>
				request(worker, { type: 'increment', id: recordId, count: perWorker }, 'incremented')
			);
			const local = [];
			for (let i = 0; i < perWorker; i++) {
				await transaction(async () => {
					const record = await ThreadTable.lock(recordId);
					const start = Date.now();
					record.set('n', (record.getProperty('n') ?? 0) + 1);
					await record.save();
					local.push({ start, end: Date.now(), worker: 0 });
				});
			}
			const intervals = (await Promise.all(runs)).flatMap((reply) => reply.intervals).concat(local);
			const total = perWorker * (workerCount + 1);
			await waitFor(() => (ThreadTable.primaryStore.getEntry(recordId)?.value?.n ?? 0) === total, {
				timeout: 5000,
				message: `all ${total} increments landed`,
			});
			assert.strictEqual(intervals.length, total);
			assert.ok(new Set(intervals.map((interval) => interval.worker)).size === workerCount + 1, 'every thread held it');
			intervals.sort((a, b) => a.start - b.start || a.end - b.end);
			for (let i = 1; i < intervals.length; i++) {
				assert.ok(
					intervals[i - 1].end <= intervals[i].start,
					`holders overlap: ${JSON.stringify(intervals[i - 1])} then ${JSON.stringify(intervals[i])}`
				);
			}
			assert.strictEqual(Boolean(ThreadTable.primaryStore.getEntry(recordId).metadataFlags & LOCKED), false);
		});
	});
});
