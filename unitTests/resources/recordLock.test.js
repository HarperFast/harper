const assert = require('assert');
const { Worker } = require('worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { MIN_LOCK_LEASE_MS } = require('#src/resources/recordLock');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Exclusive record locks (harper#483, Phase 0): the native key lock (rocksdb-js process-wide lock
// map) is the sole authority. lock() and unlock() write nothing to the store or audit log. The
// record's version and stored bytes are unchanged by acquiring or releasing a lock.
//
// Contract: lock() is mutually exclusive with other lock() calls on the same key. Ordinary writes
// (put/patch/delete/create) are NEVER gated, waited, or restaged — they proceed at real wall-clock
// time and win over a holder's write under LWW because the holder's write is stamped with the
// acquisition timestamp (≤ real time of concurrent writes).
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
	/** 'pending' when `promise` has not settled within `ms`, else 'settled'. */
	const settlement = (promise, ms = 150) =>
		Promise.race([
			promise.then(
				() => 'settled',
				() => 'settled'
			),
			delay(ms).then(() => 'pending'),
		]);

	describe('pure in-memory: no store writes', () => {
		it('lock() and unlock() do not change the record version or stored bytes', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'original' });
			const before = entryOf(recordId);
			const record = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			const locked = entryOf(recordId);
			assert.strictEqual(locked.version, before.version, 'lock() does not change the version');
			assert.strictEqual(locked.metadataFlags, before.metadataFlags, 'no metadata flag changes');
			assert.deepStrictEqual({ ...locked.value }, { id: recordId, n: 1, name: 'original' }, 'value unchanged');
			assert.ok(record.expiresAt == null, 'the record instance has no expiresAt from the lock');
			await record.unlock();
			const unlocked = entryOf(recordId);
			assert.strictEqual(unlocked.version, before.version, 'unlock() does not change the version');
		});

		it('lock() writes no audit entries', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const countBefore = [...LockTest.auditStore.getRange({ start: 1 })].filter(
				(e) => e.tableId === LockTest.tableId && e.recordId === recordId
			).length;
			const record = await LockTest.lock(recordId, { hold: true });
			await record.unlock();
			const countAfter = [...LockTest.auditStore.getRange({ start: 1 })].filter(
				(e) => e.tableId === LockTest.tableId && e.recordId === recordId
			).length;
			assert.strictEqual(countAfter, countBefore, 'no audit entries for lock/unlock');
		});

		it('throws 501 on LMDB', async function () {
			if (!isLMDB) return this.skip();
			await assert.rejects(
				async () => LockTest.lock(id()),
				(error) => error.statusCode === 501
			);
		});

		it('validates its options', async function () {
			if (isLMDB) return this.skip();
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

		it('keeps a record TTL across lock and unlock', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			const expiresAt = Date.now() + 600000;
			await LockTest.put({ id: recordId, n: 1 }, { expiresAt });
			const record = await LockTest.lock(recordId, { hold: true });
			assert.strictEqual(entryOf(recordId).expiresAt, expiresAt);
			await record.unlock();
			assert.strictEqual(entryOf(recordId).expiresAt, expiresAt);
		});
	});

	describe('transaction scope', () => {
		it('releases at commit, after the holder wrote through the returned record', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			await transaction(async () => {
				const record = await LockTest.lock(recordId);
				record.set('n', record.getProperty('n') + 1);
				await record.save();
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 2);
			// lock released: a second lock can be acquired immediately
			const handle = await LockTest.lock(recordId, { hold: true });
			await handle.unlock();
		});

		it('releases on abort and the write is rolled back', async function () {
			if (isLMDB) return this.skip();
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
			assert.strictEqual((await LockTest.get(recordId)).n, 1);
			// lock released: a second lock can be acquired immediately
			const handle = await LockTest.lock(recordId, { hold: true });
			await handle.unlock();
		});

		it('is re-entrant within the transaction and lets the static verbs write', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const versionBefore = entryOf(recordId).version;
			await transaction(async () => {
				await LockTest.lock(recordId);
				// second lock() returns the existing handle, no second native tryLock
				await LockTest.lock(recordId);
				assert.strictEqual(entryOf(recordId).version, versionBefore, 're-entrant call writes nothing');
				await LockTest.patch(recordId, { name: 'patched' });
			});
			assert.strictEqual((await LockTest.get(recordId)).name, 'patched');
		});

		it('fails a waiting lock() with 423 at its timeout', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			await assert.rejects(
				transaction(() => LockTest.lock(recordId, { timeout: 150 })),
				(error) => error.statusCode === 423
			);
			await holder.unlock();
		});
	});

	describe('concurrent writes: no gating', () => {
		it('a plain put to a held record proceeds immediately and is visible', async function () {
			// Ordinary writes are never gated on a held lock: they proceed at real wall-clock time.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			// Put must not block waiting for the lock to be released.
			const putP = LockTest.put({ id: recordId, n: 42 });
			assert.strictEqual(await settlement(putP, 500), 'settled', 'put to held record is not gated');
			assert.strictEqual((await LockTest.get(recordId)).n, 42, 'put is immediately visible');
			// holder write after the concurrent put: acquisition timestamp < put time, so holder loses LWW
			holder.set('n', 99);
			await holder.save();
			const final = await LockTest.get(recordId);
			assert.strictEqual(final.n, 42, 'concurrent write wins over later holder write under LWW');
			await holder.unlock();
		});

		it('holder write stamped at acquisition time wins against pre-lock value, loses to concurrent write', async function () {
			// Lock K at t0; concurrent context puts K at t1 > t0; holder writes at t2.
			// The holder's write carries version == t0 (acquisition time), so the concurrent write
			// at t1 supersedes it. Without a concurrent write, the holder's value is the latest.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });

			// Case A: holder write, no concurrent write → holder's value lands.
			const holderA = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			holderA.set('n', 7);
			await holderA.save();
			const afterHolderOnly = await LockTest.get(recordId);
			assert.strictEqual(afterHolderOnly.n, 7, 'holder write lands when no concurrent write exists');
			const holderOnlyVersion = entryOf(recordId).version;
			// The holder's write version must be ≤ real wall-clock time (not later than now).
			assert.ok(holderOnlyVersion <= Date.now() + 5, 'version is a realistic timestamp');
			await holderA.unlock();

			// Case B: concurrent write at t1 > t0 beats the holder write.
			await LockTest.put({ id: recordId, n: 0, name: 'seed' });
			const holderB = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			// Another context writes the record while the holder holds the lock.
			await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 50, name: 'concurrent' }));
			// Now the holder tries to overwrite — its acquisition timestamp < concurrent write's time.
			holderB.set('n', 99);
			await holderB.save();
			const final = await LockTest.get(recordId);
			assert.strictEqual(final.n, 50, 'concurrent write (later timestamp) wins over holder write');
			assert.strictEqual(final.name, 'concurrent');
			await holderB.unlock();
		});

		it('two lock() callers are exclusive; a plain writer on a concurrent task is not blocked', async function () {
			// lock() is mutually exclusive with lock(), but ordinary puts proceed at any time.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });

			// Lock holder A holds the lock.
			const holderA = await LockTest.lock(recordId, { hold: true, lease: 5000 });

			// Contender B: lock() attempt should block until A releases.
			let bResolved = false;
			const bLock = transaction(async () => {
				await LockTest.lock(recordId, { timeout: 5000 });
				bResolved = true;
			});

			// Give the event loop a few ticks so B can attempt and park.
			await delay(50);
			assert.strictEqual(bResolved, false, 'lock() contender B is still waiting');

			// Plain write C: must proceed immediately while A still holds.
			const writeC = LockTest.put({ id: recordId, n: 42 });
			assert.strictEqual(await settlement(writeC, 500), 'settled', 'plain put is not gated by the lock');
			assert.strictEqual((await LockTest.get(recordId)).n, 42, 'plain put is visible');

			// Release A: B should now acquire the lock.
			await holderA.unlock();
			await bLock;
			assert.strictEqual(bResolved, true, 'lock() contender acquired after A released');
		});

		it('scoped lock: concurrent put landing after lock() wins over the holder write', async function () {
			// Verifies acquisition-timestamp stamping for scoped (non-hold) locks:
			// lock() pins the transaction clock at acquiredAt; a concurrent write at real (later)
			// time gets a higher version and wins under LWW even though it arrives "after" the lock.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0, name: 'original' });
			let holderRecord;
			const txnPromise = transaction(async () => {
				holderRecord = await LockTest.lock(recordId, { timeout: 5000 });
				// Concurrent write lands while the scoped lock is held but before the holder writes.
				await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 99, name: 'concurrent' }));
				// Full-update (put) so the out-of-order drop fires: the holder's write at T1 is
				// superseded by the concurrent put at T2; no-audit tables drop it via the
				// fullUpdate + precedesExisting<0 path rather than merging the patch.
				await holderRecord.save({ id: recordId, n: 1, name: 'holder' }, true);
			});
			await txnPromise;
			const after = await LockTest.get(recordId);
			assert.strictEqual(after.n, 99, 'concurrent put wins (later timestamp beats acquisition-stamped write)');
			assert.strictEqual(after.name, 'concurrent');
		});
	});

	describe('lease', () => {
		it('expires an abandoned lock: the record survives, a waiter proceeds, and the old holder has lost it', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'keep' });
			const abandoned = await LockTest.lock(recordId, { hold: true, lease: 300 });
			const waiter = transaction(async () => {
				const record = await LockTest.lock(recordId, { timeout: 5000 });
				record.set('n', 2);
				await record.save();
			});
			await waiter;
			const entry = entryOf(recordId);
			assert.deepStrictEqual(
				{ n: entry.value.n, name: entry.value.name },
				{ n: 2, name: 'keep' },
				'record and value survive the lease expiry'
			);
			assert.strictEqual(await abandoned.unlock(), false, 'the expired holder cannot release the key again');
		});

		it('save() on a lockWritable record with no effective change does not loop', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 42 });
			const holder = await LockTest.lock(recordId, { hold: true });
			holder.set('n', 42); // same value — hasChanges returns false
			await holder.save(); // must complete without looping
			assert.strictEqual((await LockTest.get(recordId)).n, 42);
			await holder.unlock();
		});
	});

	describe('hold snapshot freshness', function () {
		it('{hold:true} lock() reloads the latest committed value, not the transaction snapshot', async function () {
			// Verifies that #reloadLocked reads primaryStore.getEntry(id) directly (no snapshot),
			// so a bump by another context between the transaction start and the lock() call is visible.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await transaction(async () => {
				// Pull the record into the transaction snapshot (n=0 at this point).
				await LockTest.get(recordId);
				// Another context writes n=10 while this transaction's snapshot is still pinned.
				await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 10 }));
				// lock({hold:true}) reloads from primaryStore.getEntry — must see n=10, not n=0.
				const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
				holder.set('n', holder.getProperty('n') + 1);
				await holder.save();
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 11, 'hold read reflects the bump, not the stale snapshot');
		});
	});

	describe('double-commit and expired-handle guards', function () {
		it('a locked-record hold save writes the correct value and does not loop', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const versionAfterPut = LockTest.primaryStore.getEntry(recordId).version;
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			holder.set('n', 7);
			await holder.save();
			const entry = LockTest.primaryStore.getEntry(recordId);
			assert.strictEqual(entry.value.n, 7, 'value landed');
			assert.ok(entry.version > versionAfterPut, 'version advanced after save');
			// Version must be stable immediately after save() resolves; a looping re-save would keep bumping it.
			const secondEntry = LockTest.primaryStore.getEntry(recordId);
			assert.strictEqual(secondEntry.version, entry.version, 'no further commits after save');
			await holder.unlock();
		});

		it('sequential saves on a hold-locked record each commit their own changes (CLAIM 1)', async function () {
			// Gemini CLAIM 1: second save() re-submits the stale first #savingOperation and ignores
			// new changes.  Verify both writes land; a third save with a new field verifies the pattern
			// is not special-cased to two saves.  Also cover the same sequence inside a transaction().
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0, name: 'original' });

			// Held lock outside a transaction scope.
			const record = await LockTest.lock(recordId, { hold: true, lease: 10000 });
			record.set('n', 1);
			await record.save();
			record.set('n', 2);
			await record.save();
			record.set('name', 'updated');
			await record.save();
			await record.unlock();
			const afterHold = await LockTest.get(recordId);
			assert.strictEqual(afterHold.n, 2, 'second save landed (hold, out-of-txn)');
			assert.strictEqual(afterHold.name, 'updated', 'third save landed (hold, out-of-txn)');

			// Scoped lock inside a transaction().
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId);
				scoped.set('n', 3);
				await scoped.save();
				scoped.set('n', 4);
				await scoped.save();
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 4, 'second save landed (scoped, in-txn)');
		});

		it('a write after lease expiry and re-lock does not throw 409', async function () {
			// Without MINOR fix: recordLockFor returns the expired handle first when both the expired
			// and live handles share the same transaction's recordLocks, causing a spurious 409 on
			// a write that should succeed via the live handle.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			// Both lock() calls share the same outer transaction's recordLocks.
			await transaction(async () => {
				// Acquire a short-lived hold; let it expire so recordLocks contains an expired handle.
				await LockTest.lock(recordId, { hold: true, lease: MIN_LOCK_LEASE_MS });
				await delay(MIN_LOCK_LEASE_MS + 50);
				// Re-acquire: a live handle is now registered alongside the expired one.
				await LockTest.lock(recordId, { hold: true, lease: 5000 });
				// A write to the same key must use the live handle — not the expired one — and not throw.
				await LockTest.put({ id: recordId, n: 1 });
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'write committed');
		});
	});

	describe('recreate-after-delete race (issue-(f))', function () {
		// Mirrors integrationTests/database/deleteUpdateRace.test.ts subtest (f):
		// one ImmediateTransaction context (HTTP request), seed put, then
		// Promise.allSettled([Table.delete(k), Table.create({id:k,...})]).
		// On Linux/Bun/uWS with threads:{count:4} this hung indefinitely before gate removal.

		it('Promise.allSettled([delete, create-of-same-key]) does not hang — single context', async function () {
			if (isLMDB) return this.skip();
			this.timeout(10_000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const [delP, createP] = await Promise.allSettled([
				LockTest.delete(recordId),
				(async () => LockTest.create({ id: recordId, n: 99 }))(),
			]);
			assert.ok(delP.status === 'fulfilled' || delP.status === 'rejected', 'delete settled');
			assert.ok(createP.status === 'fulfilled' || createP.status === 'rejected', 'create settled');
		});

		it('Promise.allSettled([delete, create-of-same-key]) does not hang — shared transaction()', async function () {
			if (isLMDB) return this.skip();
			this.timeout(10_000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await transaction(async () => {
				const [delP, createP] = await Promise.allSettled([
					LockTest.delete(recordId),
					(async () => LockTest.create({ id: recordId, n: 99 }))(),
				]);
				assert.ok(delP.status === 'fulfilled' || delP.status === 'rejected', 'delete settled');
				assert.ok(createP.status === 'fulfilled' || createP.status === 'rejected', 'create settled');
			});
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
			if (isLMDB) return this.skip();
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
			await Promise.all(workers.map((worker) => worker.terminate()));
			workers = [];
		});

		it('a terminated worker thread releases its held lock so a waiter can acquire it', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await ThreadTable.put({ id: recordId, n: 1 });
			// Start a fresh worker (outside the reusable pool) so we can terminate it cleanly.
			const dying = new Worker(__dirname + '/recordLock-thread.js', { workerData: { addPorts: [] } });
			await request(dying, { type: 'hold', id: recordId, lease: 30_000 }, 'held');
			// Verify the lock is actually held by trying to acquire it (should 423 at short timeout).
			await assert.rejects(
				transaction(() => ThreadTable.lock(recordId, { timeout: 100 })),
				(error) => error.statusCode === 423,
				'lock() correctly returns 423 while the dying worker holds it'
			);
			// A plain put proceeds immediately even though the lock is held.
			const putP = ThreadTable.put({ id: recordId, n: 2 });
			assert.strictEqual(await settlement(putP, 500), 'settled', 'plain put is not gated by the held lock');
			await putP;
			// Terminate the worker; rocksdb-js ~DBHandle() calls lockReleaseByOwner.
			await dying.terminate();
			// Now a lock() attempt must succeed without 423.
			await transaction(async () => {
				const rec = await ThreadTable.lock(recordId, { timeout: 2000 });
				rec.set('n', 3);
				await rec.save();
			});
			assert.strictEqual((await ThreadTable.get(recordId)).n, 3, 'lock acquired after dying worker released it');
		});

		it('two lock() callers on different threads are exclusive; a plain put on a third task is not blocked', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await ThreadTable.put({ id: recordId, n: 1 });
			// Worker holds the lock.
			await request(workers[0], { type: 'hold', id: recordId, lease: 5000 }, 'held');
			// lock() on this thread returns 423 at short timeout.
			await assert.rejects(
				transaction(() => ThreadTable.lock(recordId, { timeout: 150 })),
				(error) => error.statusCode === 423
			);
			// Plain put on this thread is NOT blocked by the held lock.
			const put = ThreadTable.put({ id: recordId, n: 2 });
			assert.strictEqual(await settlement(put, 500), 'settled', 'plain put not blocked by held lock');
			await put;
			assert.strictEqual((await ThreadTable.get(recordId)).n, 2, 'put committed');
			// Release the worker's lock.
			const released = await request(workers[0], { type: 'release' }, 'released');
			assert.strictEqual(released.cleared, true);
		});

		it('serializes increments from every thread: exact count, no overlapping holders', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			const perWorker = 15;
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
		});
	});
});
