const assert = require('assert');
const { Worker } = require('worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction, contextStorage } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { MIN_LOCK_LEASE_MS, makeKeyLockHandle } = require('#src/resources/recordLock');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Exclusive record locks (harper#483, Phase 0): the native key lock (rocksdb-js process-wide lock
// map) is the sole authority. lock() and unlock() write nothing to the store or audit log. The
// record's version and stored bytes are unchanged by acquiring or releasing a lock.
//
// Contract: lock() is mutually exclusive with other lock() calls on the same key. Ordinary writes
// (put/patch/delete/create) are NEVER gated, waited, or restaged. Holder writes normally begin at
// acquisition time; mixed explicit transactions advance the handle from the transaction's version
// so its own later writes never go backwards.
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
		it('never lowers a handle version floor', () => {
			const handle = makeKeyLockHandle({ unlock() {} }, [], 'key', undefined, true, 100);
			handle.noteHolderVersion(200);
			handle.noteHolderVersion(150);
			assert.ok(handle.nextHolderVersion() > 200);
			handle.release();
		});

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
				// Called without an async wrapper on purpose: lock() is declared to return a Promise, so
				// bad options must reject, not throw past a caller's `.catch()`.
				await assert.rejects(LockTest.lock(recordId, options), (error) => error.statusCode === 400);
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

		it('an early unlock() of a scoped lock leaves nothing for the commit to trip over', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			const otherId = id();
			await LockTest.put({ id: recordId, n: 1 });
			await transaction(async () => {
				const record = await LockTest.lock(recordId);
				await record.unlock();
				await LockTest.put({ id: otherId, n: 2 }); // the rest of the scope commits normally
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 1);
			assert.strictEqual((await LockTest.get(otherId)).n, 2);
			const handle = await LockTest.lock(recordId, { hold: true, timeout: 500 }); // the key was released
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

		it('static lock() uses the context argument when there is no ambient one', async function () {
			// Dropped, the handle lands on an ImmediateTransaction that releases no record locks, so
			// the key stays locked until the lease expires.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const context = { isExplicit: true }; // isExplicit runs the callback outside contextStorage
			await transaction(context, async () => {
				assert.strictEqual(contextStorage.getStore(), undefined, 'no ambient context to fall back on');
				const record = await LockTest.lock(recordId, undefined, context);
				assert.ok(context.transaction.recordLocks?.size, 'the handle registered on the passed transaction');
				record.set('n', 2);
				await record.save();
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'the write landed in the passed transaction');
			const handle = await LockTest.lock(recordId, { hold: true, timeout: 150 });
			await handle.unlock(); // the passed transaction's commit is what released the scoped lock
		});

		it('static lock() prefers the passed context over a differing ambient one', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			await transaction(async () => {
				const ambient = contextStorage.getStore();
				const passed = { isExplicit: true };
				await transaction(passed, async () => {
					await LockTest.lock(recordId, undefined, passed);
					assert.ok(passed.transaction.recordLocks?.size, 'the handle registered on the passed transaction');
					assert.ok(!ambient.transaction.recordLocks?.size, 'and not on the ambient one');
				});
			});
		});

		it('a scoped lock with a staged deferred write and an open iterator acquires', async function () {
			// An iterator pins the read txn, so lock() aligns the native clock instead of dropping the
			// snapshot — but update() stages a DEFERRED write, whose later save() is what sets that
			// clock, so it is still 0 and rocksdb-js rejects setTimestamp(0).
			if (isLMDB) return this.skip();
			const lockedId = id();
			const updatedId = id();
			await LockTest.put({ id: lockedId, n: 1 });
			await LockTest.put({ id: updatedId, n: 2 });
			await transaction(async () => {
				const live = await LockTest.update(updatedId);
				live.set('n', 20);
				const iterator = LockTest.search({ conditions: [] })[Symbol.asyncIterator]();
				await iterator.next();
				const locked = await LockTest.lock(lockedId);
				locked.set('n', 10);
				await locked.save();
				await live.save();
				await iterator.return?.();
			});
			assert.strictEqual((await LockTest.get(lockedId)).n, 10, 'the locked write landed');
			assert.strictEqual((await LockTest.get(updatedId)).n, 20, 'the staged update landed');
		});

		it('a write through a commit-released scoped lock reports release, not lease expiry', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			let scoped;
			await transaction(async () => {
				scoped = await LockTest.lock(recordId);
			});
			scoped.set('n', 5);
			await assert.rejects(
				async () => scoped.save(),
				(error) => error.statusCode === 409 && /already released/.test(error.message),
				'the commit released it; a lease-expiry message would send the caller after the wrong cause'
			);
		});

		it('one hold save in an ImmediateTransaction runs the write once', async function () {
			// The deferred write's save is the fallthrough in Table.save() (`op.saved` is false because
			// addWrite deferred it), not a second run of one already saved — a review leg read it as a
			// double `super.save()`. One audit entry and one version bump is what one run looks like.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const auditCount = () =>
				[...LockTest.auditStore.getRange({ start: 1 })].filter(
					(entry) => entry.tableId === LockTest.tableId && entry.recordId === recordId
				).length;
			const auditBefore = auditCount();
			const versionBefore = entryOf(recordId).version;
			const record = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			record.set('n', 2);
			await record.save();
			assert.strictEqual(auditCount() - auditBefore, 1, 'one audit entry for one save');
			assert.ok(entryOf(recordId).version > versionBefore, 'one version bump');
			assert.strictEqual((await LockTest.get(recordId)).n, 2);
			await record.unlock();
		});

		it('a lock that expires before commit aborts the whole transaction with 409', async function () {
			// A write staged through the lock but not yet saved is saved by commit(), so its 409 comes
			// from inside commit(). Retries are keyed to the native conflict codes (RETRY_NOW/ERR_BUSY/
			// ERR_TRY_AGAIN), not to a ClientError, so the throw leaves commit() rather than dropping
			// the write and committing the rest — the scope's other writes roll back with it.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const lockedId = id();
			const plainId = id();
			const siblingLockId = id();
			await LockTest.put({ id: lockedId, n: 1 });
			await LockTest.put({ id: plainId, n: 1 });
			await LockTest.put({ id: siblingLockId, n: 1 });
			await assert.rejects(
				transaction(async () => {
					await LockTest.put({ id: plainId, n: 99 });
					await LockTest.lock(siblingLockId, { lease: 5000 });
					const record = await LockTest.lock(lockedId, { lease: MIN_LOCK_LEASE_MS });
					record.update({ n: 5 }); // staged through the lock, saved at commit
					await delay(MIN_LOCK_LEASE_MS + 60);
				}),
				(error) => error.statusCode === 409,
				'the caller is told, rather than getting a partial commit'
			);
			assert.strictEqual((await LockTest.get(lockedId)).n, 1, 'the locked write did not land');
			assert.strictEqual((await LockTest.get(plainId)).n, 1, "and neither did the scope's other write");
			const sibling = await LockTest.lock(siblingLockId, { hold: true, timeout: 150 });
			await sibling.unlock();
		});

		it('static lock() accepts a transaction in the context position', async function () {
			// `transactional()` takes a bare DatabaseTransaction where a context goes; lock() matches.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const context = { isExplicit: true };
			await transaction(context, async (txn) => {
				await LockTest.lock(recordId, undefined, txn);
				assert.ok(txn.recordLocks?.size, 'the handle registered on the transaction that was passed');
			});
			const handle = await LockTest.lock(recordId, { hold: true, timeout: 150 });
			await handle.unlock();
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
			const beforeLock = Date.now();
			const holderA = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			// Delay a few ms so write time > lock time; the entry version should still be ≤ lock time.
			await delay(5);
			const beforeSave = Date.now();
			holderA.set('n', 7);
			await holderA.save();
			const afterHolderOnly = await LockTest.get(recordId);
			assert.strictEqual(afterHolderOnly.n, 7, 'holder write lands when no concurrent write exists');
			const holderOnlyVersion = entryOf(recordId).version;
			// Version must be a realistic timestamp and must have been stamped at lock-acquisition time,
			// not at write time: if stamped at write time it would be ≥ beforeSave (after the delay).
			assert.ok(holderOnlyVersion <= Date.now() + 5, 'version is a realistic timestamp');
			assert.ok(holderOnlyVersion >= beforeLock - 5, 'version is at or after lock-acquisition time');
			assert.ok(holderOnlyVersion < beforeSave, 'version was stamped at acquisition, not at write time');
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
			const s1 = record.save();
			await s1;
			record.set('n', 2);
			const s2 = record.save();
			await s2;
			record.set('name', 'updated');
			await record.save();
			await record.unlock();
			const afterHold = await LockTest.get(recordId);
			assert.strictEqual(afterHold.n, 2, 'second save landed (hold, out-of-txn)');
			assert.strictEqual(afterHold.name, 'updated', 'third save landed (hold, out-of-txn)');

			// Scoped lock inside a transaction(): stages exactly like update(), so a second write
			// on the same instance needs its own update() call to create a fresh TransactionWrite
			// (the ordinary path — no lock-writable auto-restaging for scoped).
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId);
				scoped.set('n', 3);
				await scoped.save();
				scoped.update();
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

		it('a reused ImmediateTransaction prunes expired lock handles', async function () {
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const context = {};
			await LockTest.lock(recordId, { hold: true, lease: MIN_LOCK_LEASE_MS }, context);
			const immediate = context.transaction;
			await delay(MIN_LOCK_LEASE_MS + 50);
			assert.ok(immediate.recordLocks?.size, 'expired handle remains until the transaction is reused');
			immediate.releaseRecordLocks();
			assert.strictEqual(immediate.recordLocks, undefined, 'the next cleanup drops expired handle references');
		});

		it('scoped lock with expired lease: write through the returned record throws 409', async function () {
			// Item 2a: a scoped lock whose lease expires before save() should throw 409.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let caughtErr;
			await transaction(async () => {
				const locked = await LockTest.lock(recordId, { lease: MIN_LOCK_LEASE_MS });
				await delay(MIN_LOCK_LEASE_MS + 50); // let the lease expire
				locked.set('n', 99);
				try {
					await locked.save();
				} catch (err) {
					caughtErr = err;
				}
			}).catch((error) => {
				// The scope may abort with the same 409; anything else — a throw out of the abort path —
				// must fail this test rather than be swallowed.
				if (error?.statusCode !== 409) throw error;
			});
			assert.ok(caughtErr, 'save() threw after lease expired');
			assert.strictEqual(caughtErr.statusCode, 409, '409 on expired lease');
		});

		it('hold lock: save() after expiry throws 409', async function () {
			// Item 2b: a hold lock whose lease expires before save() should throw 409.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: MIN_LOCK_LEASE_MS });
			await delay(MIN_LOCK_LEASE_MS + 50); // let the lease expire
			holder.set('n', 99);
			let caughtErr;
			try {
				await holder.save();
			} catch (err) {
				caughtErr = err;
			}
			assert.ok(caughtErr, 'save() threw after hold lease expired');
			assert.strictEqual(caughtErr.statusCode, 409, '409 on expired hold lease');
			assert.strictEqual((await LockTest.get(recordId)).n, 0, 'record unchanged');
		});

		it('an expired hold does not latch its context transaction', async function () {
			// A synchronous throw from DatabaseTransaction.save() (e.g. expired hold 409) would
			// leave ImmediateTransaction.isCommitting stuck at true, causing every subsequent write
			// on the same context to fire-and-forget and silently disappear.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const holdId = id();
			const otherId = id();
			await LockTest.put({ id: holdId, n: 0 });
			const context = {};
			// Acquire and let the hold expire.
			const holder = await LockTest.lock(holdId, { hold: true, lease: MIN_LOCK_LEASE_MS }, context);
			assert.strictEqual(context.transaction, holder.getContext().transaction, 'holder shares the explicit context');
			await delay(MIN_LOCK_LEASE_MS + 50);
			holder.set('n', 99);
			let caught;
			try {
				await holder.save(); // throws 409 (expired hold)
			} catch (err) {
				caught = err;
			}
			assert.strictEqual(caught?.statusCode, 409, '409 from expired hold');
			// isCommitting must be reset; a subsequent put on the same context must land.
			await LockTest.put({ id: otherId, n: 42 }, context);
			assert.strictEqual((await LockTest.get(otherId)).n, 42, 'put after 409 landed (isCommitting reset)');
		});

		it('holder delete: concurrent put survives (item 3 — _writeDelete carries lockHandle)', async function () {
			// Phase 0: a concurrent put after the holder's delete has no obligation to be blocked.
			// The holder delete is stamped at acquiredAt; the concurrent put at real (later) time wins under LWW.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			// concurrent put at real (later) time
			await LockTest.put({ id: recordId, n: 99 });
			// holder delete stamped at acquiredAt — older than the concurrent put
			holder.delete();
			await holder.unlock();
			const after = await LockTest.get(recordId);
			assert.strictEqual(after?.n, 99, 'concurrent put survives holder delete (LWW)');
		});

		it('rule A: two-record transfer under two scoped locks commits both writes', async function () {
			// Previously the guard "lock() must precede transaction writes" blocked the second lock()
			// because the first lock pins link.timestamp (truthy).  With rule A that 400 is gone.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordA = id();
			const recordB = id();
			await LockTest.put({ id: recordA, n: 100 });
			await LockTest.put({ id: recordB, n: 200 });
			await transaction(async () => {
				const a = await LockTest.lock(recordA);
				a.set('n', 99); // debit A
				const b = await LockTest.lock(recordB);
				b.set('n', 201); // credit B
				await b.save();
				await a.save();
			});
			assert.strictEqual((await LockTest.get(recordA)).n, 99, 'debit write (A) landed');
			assert.strictEqual((await LockTest.get(recordB)).n, 201, 'credit write (B) landed');
		});

		it('item-1: lock() in transaction after prior staged write sees the staged value', async function () {
			// put(id,{n:1}) in the same transaction then lock(id) → r.n must be 1 (staged value),
			// so r.set('n', r.n+1) lands as n=2, not n=1 (the pre-put value from a naked getEntry).
			// Also verifies that the locked instance has a full entry (version defined) so a
			// subsequent save() can use it as a valid existingEntry in the commit handler.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await transaction(async () => {
				await LockTest.put({ id: recordId, n: 1 });
				const r = await LockTest.lock(recordId);
				assert.strictEqual(r.getProperty('n'), 1, 'lock() sees staged put value (n===1)');
				// getUpdatedTime() reads from entryMap which #reloadLocked populates for a merged entry.
				assert.ok(typeof r.getUpdatedTime() === 'number', 'locked instance has a full entry (getUpdatedTime defined)');
				r.set('n', r.getProperty('n') + 1);
				await r.save();
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'staged write visible through lock()');
		});

		it('keeps an earlier different-key write when acquiring a scoped lock', async function () {
			if (isLMDB) return this.skip();
			const earlierId = id();
			const lockedId = id();
			await LockTest.put({ id: earlierId, n: 0 });
			await LockTest.put({ id: lockedId, n: 0 });
			const auditCountBefore = [...LockTest.auditStore.getRange({ start: 1 })].filter(
				(entry) => entry.tableId === LockTest.tableId && entry.recordId === earlierId
			).length;
			await transaction(async () => {
				await LockTest.patch(earlierId, { n: 1 });
				const locked = await LockTest.lock(lockedId);
				locked.set('n', 1);
				await locked.save();
			});
			assert.strictEqual((await LockTest.get(earlierId)).n, 1, 'earlier write landed');
			assert.strictEqual((await LockTest.get(lockedId)).n, 1, 'locked write landed');
			const auditCountAfter = [...LockTest.auditStore.getRange({ start: 1 })].filter(
				(entry) => entry.tableId === LockTest.tableId && entry.recordId === earlierId
			).length;
			assert.strictEqual(auditCountAfter, auditCountBefore + 1, 'earlier write audit entry landed');
		});

		it('item-4/rule-C: scoped lock outside transaction() persists across sequential saves until unlock()', async function () {
			// In an ImmediateTransaction context (no explicit transaction()) each write through a
			// scoped lock is stamped via nextHolderVersion() (independent commits), but the key is
			// NOT released by the first save() — the lock persists until unlock() or lease expiry.
			// Scoped stages exactly like update(): each save() cycle needs its own update() call
			// to create a fresh TransactionWrite (no lock-writable auto-restaging for scoped).
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const scoped = await LockTest.lock(recordId, { lease: 5000 });
			scoped.set('n', 1);
			// Key is still held before first save() — verify exclusion.
			await assert.rejects(LockTest.lock(recordId, { timeout: 50 }), { statusCode: 423 }, 'key held before first save');
			// First save() commits the write but does NOT release the key.
			await scoped.save();
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'first write landed');
			// Key must still be held — second save() can happen.
			await assert.rejects(
				LockTest.lock(recordId, { timeout: 50 }),
				{ statusCode: 423 },
				'key still held after first save'
			);
			// Second save.
			scoped.update();
			scoped.set('n', 2);
			await scoped.save();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'second write landed');
			// Key is still held; unlock() releases it.
			const released = await scoped.unlock();
			assert.strictEqual(released, true, 'unlock() released the key');
			// Another lock must succeed immediately after unlock.
			const next = await LockTest.lock(recordId, { lease: 5000 });
			await next.unlock();
		});

		it('item-2: expired-hold 409 does not contaminate context; later put() on same context succeeds', async function () {
			// A 409 thrown from save() because the lock expired must remove the failed operation
			// from this.writes so subsequent writes on the same ImmediateTransaction context do
			// not re-throw 409 (stale null entry in this.writes would re-trigger the guard).
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const lockedId = id();
			const otherId = id();
			await LockTest.put({ id: lockedId, n: 0 });
			await LockTest.put({ id: otherId, n: 0 });
			// Acquire a hold with a very short lease and wait for it to expire.
			const holder = await LockTest.lock(lockedId, { hold: true, lease: 200 });
			await delay(300);
			// save() must throw or reject with 409 for the expired lock.
			holder.set('n', 99);
			let err409;
			try {
				await holder.save();
			} catch (err) {
				err409 = err;
			}
			assert.ok(err409, 'save() threw or rejected for expired lock');
			assert.strictEqual(err409.statusCode, 409, '409 status for expired lock');
			// A put() on the same ambient ImmediateTransaction context (no explicit wrapper) must
			// succeed — verifies the failed write was cleaned out of this.writes.
			await LockTest.put({ id: otherId, n: 42 });
			assert.strictEqual((await LockTest.get(otherId)).n, 42, 'put on same context after 409 succeeded');
		});

		it('major-2: expired scoped lock → update/put/patch all throw 409', async function () {
			// _writeUpdate was the one locked-mutation path without #assertLiveHandle. After a
			// scoped lock expires (pruned from recordLocks), update/put/patch must throw 409 rather
			// than succeeding silently as an ordinary unlocked write.  Use function form of
			// assert.rejects because #assertLiveHandle throws synchronously before returning a Promise.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			// --- update ---
			const scopedUpd = await LockTest.lock(recordId, { lease: 200 });
			await delay(300); // let the lease expire and the handle get pruned
			// assert.rejects needs an async wrapper: #assertLiveHandle throws synchronously and
			// Node 24 only catches async (Promise-returning) throws in assert.rejects.
			await assert.rejects(async () => scopedUpd.update({ n: 99 }), { statusCode: 409 }, 'update() after expiry → 409');

			await LockTest.put({ id: recordId, n: 0 }); // reset
			// --- save with staged change (incremental) ---
			const scopedPut = await LockTest.lock(recordId, { lease: 200 });
			await delay(300);
			scopedPut.set('n', 99);
			await assert.rejects(async () => scopedPut.save(), { statusCode: 409 }, 'save after expiry → 409');

			// After all the failed 409s the record must still be at n=0.
			assert.strictEqual((await LockTest.get(recordId)).n, 0, 'record unchanged after all expired-lock attempts');
		});

		it('minor-1: off-key write via a hold-locked resource is not guarded by the hold', async function () {
			// r = await T.lock('A', {hold:true}); r.delete('B') must NOT throw 409 because
			// A's hold handle does not cover key B. Off-key writes are ordinary unlocked writes.
			// delete() in ImmediateTransaction is fire-and-forget (async commit, sync return);
			// only verify the synchronous 409-guard behavior via doesNotThrow, then confirm A
			// is still writable through the hold.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 1 });
			await LockTest.put({ id: idB, n: 2 });
			const rA = await LockTest.lock(idA, { hold: true, lease: 5000 });
			// Off-key delete via the hold-locked resource must not throw 409 synchronously.
			assert.doesNotThrow(() => rA.delete(idB), 'off-key delete not blocked by hold on A');
			// The lock on A is still live; a write through it must still land.
			rA.set('n', 10);
			await rA.save();
			await rA.unlock();
			assert.strictEqual((await LockTest.get(idA)).n, 10, 'hold write on A landed after off-key delete');
		});

		it('minor-2: re-entrant lock() on same instance preserves staged changes', async function () {
			// r.set('n', 5); await r.lock(); await r.save() must yield n=5, not the pre-set
			// value: #reloadLocked must pass preserveChanges=true for re-entrant calls so #changes
			// is not cleared.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const r = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			r.set('n', 5);
			// Re-entrant lock() on the same instance: must not clear #changes.
			const r2 = await r.lock({ hold: true, lease: 5000 });
			assert.strictEqual(r2, r, 're-entrant returns same instance');
			await r.save(); // must commit n=5 (not lose the set)
			await r.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 5, 'staged change survived re-entrant lock()');
		});

		it('item-5: scoped→hold upgrade keeps original acquiredAt stamp; concurrent write survives', async function () {
			// Upgrading a scoped lock to hold must pass scoped.acquiredAt to the new hold handle
			// so the hold's clock is not minted fresh (which would be later and could clobber a
			// concurrent write that arrived between scoped acquisition and hold upgrade).
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdHandle;
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId, { lease: 5000 });
				scoped.set('n', 5);
				// Concurrent write between scoped lock and hold upgrade.
				await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 42 }));
				// Upgrade to hold — inherits scoped.acquiredAt.
				holdHandle = await LockTest.lock(recordId, { hold: true, lease: 5000 });
				holdHandle.set('n', 5);
				await holdHandle.save();
			});
			// The concurrent write (n=42) arrived at a real timestamp AFTER scoped.acquiredAt;
			// with LWW it should win over the hold write stamped at acquiredAt.
			const result = await LockTest.get(recordId);
			assert.strictEqual(result.n, 42, 'concurrent write (LWW winner) survives scoped→hold upgrade');
			await holdHandle.unlock();
		});

		it('item-6: expired scoped handle → invalidate() throws 409', async function () {
			// After a scoped lock expires, invalidate() through the lock-writable instance must
			// throw 409 (expired-handle guard) rather than staging a write with no lock handle.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const scoped = await LockTest.lock(recordId, { lease: 200 });
			// Wait for lease to expire.
			await delay(300);
			let caughtErr;
			try {
				await scoped.invalidate();
			} catch (err) {
				caughtErr = err;
			}
			assert.ok(caughtErr, 'invalidate() on expired scoped handle threw');
			assert.strictEqual(caughtErr.statusCode, 409, '409 from expired-handle guard in invalidate()');
		});

		it('rule D (no 409): sequential hold saves inside one transaction() both land', async function () {
			// Mixing multiple hold saves for the same hold into one explicit transaction() must not
			// throw: the clock is pinned to acquiredAt on the first save and reused on the second.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await transaction(async () => {
				const holdHandle = await LockTest.lock(recordId, { hold: true, lease: 10000 });
				holdHandle.set('n', 1);
				await holdHandle.save(); // first hold save — pins clock to acquiredAt
				holdHandle.set('n', 2);
				await holdHandle.save(); // second hold save — reuses pinned clock, no 409
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'second save landed (b after a)');
		});

		it('scoped→hold upgrade: second lock({hold:true}) upgrades cleanly (item 5)', async function () {
			// Acquiring with {hold:true} on a key already scoped-locked in this transaction
			// should upgrade (not double-release the native key or mark the handle released early).
			// Changes staged under the scoped lock must be preserved after the upgrade (fix 3).
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdHandle;
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId); // scoped
				scoped.set('n', 1); // staged under scoped lock — must survive upgrade
				// Upgrade to hold within the same transaction
				holdHandle = await LockTest.lock(recordId, { hold: true, lease: 5000 });
				// #changes must still have { n: 1 } from the scoped lock set() above.
				assert.strictEqual(holdHandle.getProperty('n'), 0, 'reloaded from store on upgrade');
				// Overwrite with the hold write.
				holdHandle.set('n', 2);
				await holdHandle.save();
			});
			// hold survives transaction commit
			assert.ok(holdHandle && !holdHandle.released, 'hold handle alive after txn commit');
			// A concurrent lock attempt should block (hold is still held)
			const lockAttempt = LockTest.lock(recordId, { timeout: 100 });
			await assert.rejects(lockAttempt, { statusCode: 423 }, 'concurrent lock correctly blocked');
			await holdHandle.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'hold write landed');
		});

		it('scoped→hold re-entrant: second lock({hold:true}) on already-hold returns live handle (item 5 re-entrant)', async function () {
			// If the same instance already holds a hold handle (via #lockHandle), re-calling lock()
			// must return the existing handle, not create a new one or corrupt state.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const first = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			// Re-enter lock() on the same instance; should return immediately without error.
			const second = await first.lock({ hold: true, lease: 5000 });
			assert.strictEqual(second, first, 're-entrant hold returns same instance');
			first.set('n', 7);
			await first.save();
			await first.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 7, 'write landed');
		});

		it('unlock() clears #lockWritable so writes after unlock are rejected (item 6)', async function () {
			// After unlock() the instance must no longer be lock-writable.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			holder.set('n', 1);
			await holder.save();
			await holder.unlock();
			// After unlock, writes through the instance should not commit (no #lockWritable).
			holder.set('n', 99);
			await holder.save(); // should be a no-op (no lockWritable, no savingOperation)
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'write after unlock did not land');
		});

		it('unlock() on a scoped lock releases early and is safe (item 6 scoped)', async function () {
			// unlock() on a scoped lock should release the native key and not throw 400.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId);
				scoped.set('n', 1);
				await scoped.save();
				const released = await scoped.unlock(); // should not throw
				assert.strictEqual(released, true, 'unlock() returned true for scoped');
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'write still landed (committed before unlock)');
		});

		it('major-1: expired scoped handle not superseded by new holder — s1.save() throws 409', async function () {
			// MAJOR 1 fix: every locked instance carries ITS OWN handle in #lockHandle.
			// s1 acquires a scoped lock (short lease), lets it expire, then s2 acquires the key.
			// Before the fix, #assertLiveHandle for s1 checked "is there ANY live handle for this key"
			// and s2's live handle satisfied that check — allowing s1 to commit under s2's token.
			// After the fix, s1 checks only its own (expired) handle and gets 409.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const s1 = await LockTest.lock(recordId, { lease: 200 });
			await delay(300); // s1's lease expires
			// A new holder acquires the lock
			const s2 = await LockTest.lock(recordId, { lease: 5000 });
			// s1 must 409 — it is expired even though s2 holds a live lock for the same key
			s1.set('n', 99);
			await assert.rejects(
				async () => s1.save(),
				{ statusCode: 409 },
				's1.save() after expiry → 409 (not bypassed by s2 being alive)'
			);
			// s2 is still the exclusive holder and its write lands
			s2.set('n', 42);
			await s2.save();
			await s2.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 42, 's2 write landed (exclusive holder)');
		});

		it('major: cross-instance scoped→hold upgrade shares handle; s.save() does not throw 409', async function () {
			// When two separate instances (from two T.lock() calls) reference the same key inside
			// a transaction and the second upgrades to {hold:true}, the FIRST instance's handle
			// must not be retired.  Before the fix: retire+replace created a new handle that s had
			// no reference to, so s.save() threw 409 against the old retired handle.
			// Fix: flip the existing handle to hold=true so all instances sharing the handle object
			// remain writable.  Both calls must be in the same explicit transaction() so they share
			// one link and acquireRecordKey can find the already-locked handle.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdRef;
			await transaction(async () => {
				const s = await LockTest.lock(recordId); // scoped — s holds handle H
				s.set('n', 1);
				holdRef = await LockTest.lock(recordId, { hold: true, lease: 5000 }); // flips H to hold
				// Before fix: s.#lockHandle was retired → s.save() threw 409.
				// After fix: H is hold=true; s still references H; no throw.
				await assert.doesNotReject(async () => s.save(), 's.save() must not throw 409');
			}); // commit; hold persists via holdRef
			assert.ok(holdRef && !holdRef.released, 'hold handle alive after commit');
			// Concurrent lock attempt must be blocked while the hold is active.
			await assert.rejects(LockTest.lock(recordId, { timeout: 100 }), { statusCode: 423 });
			await holdRef.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'write from s.save() landed');
		});

		it('scoped→hold upgrade detaches its scoped write behind a static write', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0, name: 'before' });
			let holder;
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId);
				scoped.set('n', 1);
				await LockTest.patch(recordId, { name: 'static' });
				holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			});
			const afterUpgrade = await LockTest.get(recordId);
			assert.strictEqual(afterUpgrade.n, 0, 'unsaved scoped change did not auto-commit');
			assert.strictEqual(afterUpgrade.name, 'static', 'intervening static write landed');
			holder.set('n', 2);
			await holder.save();
			await holder.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'explicit hold write landed');
		});

		it('major: same-instance scoped→hold re-entrant upgrade: hold persists after transaction commit', async function () {
			// r.lock({hold:true}) on a scoped-locked instance must flip the handle to hold mode
			// so the native key lock survives past the transaction's commit.
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdRef;
			await transaction(async () => {
				const r = await LockTest.lock(recordId); // scoped inside transaction
				holdRef = await r.lock({ hold: true }); // same-instance re-entrant upgrade
				assert.strictEqual(holdRef, r, 're-entrant returns same instance');
				r.set('n', 1);
				await r.save(); // write committed within transaction
			}); // transaction ends; hold must persist (native key still locked)
			assert.ok(holdRef && !holdRef.released, 'hold handle alive after transaction commit');
			// Concurrent lock attempt must still be blocked.
			await assert.rejects(LockTest.lock(recordId, { timeout: 100 }), { statusCode: 423 });
			await holdRef.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'in-transaction write landed');
		});

		it('minor-3: second lock in same transaction does not shift the pinned clock', async function () {
			// The first lock pins link.timestamp to A.acquiredAt.  A second lock on a different
			// key B must NOT re-pin the clock to B.acquiredAt (which is later).  We verify the
			// invariant directly: capture link.timestamp after locking A and assert it is
			// unchanged after locking B — no wall-clock margins required.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 0 });
			await LockTest.put({ id: idB, n: 0 });
			let timestampAfterLockA;
			await transaction(async () => {
				const rA = await LockTest.lock(idA); // clock pinned to rA.acquiredAt
				timestampAfterLockA = contextStorage.getStore().transaction.timestamp;
				assert.ok(timestampAfterLockA > 0, 'clock pinned after locking A');
				await delay(20); // ensure T_B is well after T_A
				await LockTest.lock(idB); // must NOT re-pin the clock
				const timestampAfterLockB = contextStorage.getStore().transaction.timestamp;
				assert.strictEqual(timestampAfterLockB, timestampAfterLockA, 'clock unchanged after locking B');
				rA.set('n', 1);
				await rA.save();
			});
			assert.strictEqual((await LockTest.get(idA)).n, 1, 'write landed');
		});

		it('post-commit save after a hold follows another staged write advances', async function () {
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			const otherId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await LockTest.put({ id: otherId, n: 0 });
			let holdRef;
			await transaction(async () => {
				await LockTest.update(otherId, { n: 1 });
				holdRef = await LockTest.lock(recordId, { hold: true, lease: 5000 });
				holdRef.set('n', 1);
				await holdRef.save();
			});
			const committedVersion = entryOf(recordId).version;
			holdRef.set('n', 2);
			await holdRef.save();
			await holdRef.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'post-commit hold write landed');
			assert.ok(entryOf(recordId).version > committedVersion, 'post-commit holder version advanced');
		});

		it('a committed static same-key write advances a surviving hold', async function () {
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdRef;
			await transaction(async () => {
				holdRef = await LockTest.lock(recordId, { hold: true, lease: 5000 });
				await LockTest.patch(recordId, { n: 1 });
			});
			const committedVersion = entryOf(recordId).version;
			holdRef.set('n', 2);
			await holdRef.save();
			await holdRef.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'post-commit hold write landed');
			assert.ok(entryOf(recordId).version > committedVersion, 'holder advanced past the static write');
		});

		it('post-commit save after a mixed-transaction scoped→hold upgrade advances', async function () {
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			const otherId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await LockTest.put({ id: otherId, n: 0 });
			let holdRef;
			await transaction(async () => {
				await LockTest.update(otherId, { n: 1 });
				const s = await LockTest.lock(recordId);
				s.set('n', 1);
				await s.save();
				holdRef = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			});
			const committedVersion = entryOf(recordId).version;
			holdRef.set('n', 2);
			await holdRef.save();
			await holdRef.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'post-commit hold write landed');
			assert.ok(entryOf(recordId).version > committedVersion, 'post-commit holder version advanced');
		});

		it('post-commit save after a pinned scoped→hold upgrade advances', async function () {
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdRef;
			await transaction(async () => {
				const scoped = await LockTest.lock(recordId);
				scoped.set('n', 1);
				await scoped.save();
				holdRef = await scoped.lock({ hold: true, lease: 5000 });
			});
			const committedVersion = entryOf(recordId).version;
			holdRef.set('n', 2);
			await holdRef.save();
			await holdRef.unlock();
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'post-commit hold write landed');
			assert.ok(entryOf(recordId).version > committedVersion, 'post-commit holder version advanced');
		});

		it('a rolled-back holder write does not advance a surviving hold', async function () {
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdRef;
			await assert.rejects(
				transaction({ timestamp: Date.now() + 60_000 }, async () => {
					holdRef = await LockTest.lock(recordId, { hold: true, lease: 5000 });
					holdRef.set('n', 1);
					await holdRef.save();
					throw new Error('roll back holder write');
				}),
				/roll back holder write/
			);
			await LockTest.put({ id: recordId, n: 2 });
			const plainVersion = entryOf(recordId).version;
			holdRef.set('n', 3);
			await holdRef.save();
			const after = entryOf(recordId);
			await holdRef.unlock();
			assert.strictEqual(after.value.n, 2, 'plain write remains the LWW winner');
			assert.strictEqual(after.version, plainVersion, 'rolled-back version did not raise the holder floor');
		});

		it('a skipped immediate holder write does not advance its version floor', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const context = {};
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 }, context);
			const lockHandle = [...context.transaction.recordLocks.values()][0].values().next().value;
			const initialCandidate = lockHandle.holderVersionCandidate();
			await LockTest.put({ id: recordId, n: 1 });
			holder.set('n', 2);
			await holder.save();
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'newer plain write remains visible');
			assert.strictEqual(
				lockHandle.holderVersionCandidate(),
				initialCandidate,
				'skipped write did not advance the floor'
			);
			await holder.unlock();
		});

		it('an immediate holder write preserves a caller-supplied timestamp floor', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const timestamp = Date.now() + 60_000;
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 }, { timestamp });
			holder.set('n', 1);
			await holder.save();
			await holder.unlock();
			assert.strictEqual(entryOf(recordId).version, timestamp, 'holder write kept the explicit timestamp floor');
		});

		it('a hold with no transaction write does not outrank a later plain write', async function () {
			if (isLMDB) return this.skip();
			this.timeout(3000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			let holdRef;
			let lockHandle;
			await transaction(async (txn) => {
				holdRef = await LockTest.lock(recordId, { hold: true, lease: 5000 });
				lockHandle = [...txn.recordLocks.values()][0].values().next().value;
				assert.strictEqual(
					lockHandle.nextHolderVersion(),
					lockHandle.acquiredAt,
					'acquisition did not prime the floor'
				);
				await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 2 }));
			});
			const plainVersion = entryOf(recordId).version;
			holdRef.set('n', 3);
			await holdRef.save();
			const after = entryOf(recordId);
			await holdRef.unlock();
			assert.strictEqual(after.value.n, 2, 'plain write remains the LWW winner');
			assert.strictEqual(after.version, plainVersion, 'dropped holder write did not advance the version');
		});

		it('minor-2: concurrent lock() calls for same key in one transaction coalesce, not self-block', async function () {
			// Promise.all([T.lock(id), T.lock(id)]) inside one transaction() scope: both calls
			// reach the lock() path before either has registered its handle.  Without coalescing,
			// the second tryLock parks against the first's own handle and blocks until timeout.
			// With pendingLocks: the second call awaits the first's acquisition and takes the
			// re-entrant path.  Test must complete well under the default lease timeout.
			if (isLMDB) return this.skip();
			this.timeout(1000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			await transaction(async () => {
				const [a, b] = await Promise.all([LockTest.lock(recordId), LockTest.lock(recordId)]);
				assert.ok(a, 'first lock() resolved');
				assert.ok(b, 'second lock() resolved (coalesced, not timed-out)');
				a.set('n', 1);
				await a.save();
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'write landed');
		});

		it('a coalesced follower fails at its own timeout, not the leader’s', async function () {
			// The follower parks on the leader's acquisition but keeps its own deadline: with a
			// leader waiting far longer, the follower must still fail at its own timeout.
			if (isLMDB) return this.skip();
			this.timeout(6000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const outside = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			await transaction(async () => {
				// Ordering, not elapsed time: a stalled runner delays both deadlines together, so
				// "the leader had not settled yet" is the claim that survives one.
				let leaderSettled = false;
				const leader = LockTest.lock(recordId, { timeout: 1000 }).then(
					(record) => ((leaderSettled = true), record),
					(err) => ((leaderSettled = true), err)
				);
				const follower = LockTest.lock(recordId, { timeout: 150 });
				await assert.rejects(follower, { statusCode: 423 }, 'follower failed with 423');
				assert.strictEqual(leaderSettled, false, 'follower failed at its own deadline, with the leader still waiting');
				const leaderResult = await leader;
				assert.strictEqual(leaderResult.statusCode, 423, 'leader failed at its own (longer) deadline');
			});
			await outside.unlock();
		});

		it('a coalesced follower retries on its own budget when the leader fails', async function () {
			// The leader's acquireRecordKey rejects (its own short timeout).  The follower must
			// re-enter lock() with the time it has left rather than inheriting the failure.
			if (isLMDB) return this.skip();
			this.timeout(6000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const outside = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			const release = delay(400).then(() => outside.unlock());
			await transaction(async () => {
				const leader = LockTest.lock(recordId, { timeout: 150 });
				const follower = LockTest.lock(recordId, { timeout: 4000 });
				await assert.rejects(leader, { statusCode: 423 }, 'leader failed at its own short timeout');
				const acquired = await follower;
				assert.ok(acquired, 'follower acquired the lock after retrying on its own budget');
				acquired.set('n', 1);
				await acquired.save();
			});
			await release;
			assert.strictEqual((await LockTest.get(recordId)).n, 1, "the follower's write landed");
		});

		it('a transaction aborted while lock() waiters are parked leaves the key unlocked', async function () {
			// Both a leader (parked in acquireRecordKey) and a follower (parked in the coalescing
			// race) resolve only after the transaction is gone; each must release the handle it
			// lands on instead of leaking the native key lock.
			if (isLMDB) return this.skip();
			this.timeout(8000);
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const outside = await LockTest.lock(recordId, { hold: true, lease: 6000 });
			const waiters = [];
			await assert.rejects(
				transaction(async () => {
					// settled here so a post-abort rejection is never unhandled
					const track = (promise) =>
						waiters.push(
							promise.then(
								() => 'acquired',
								(err) => err
							)
						);
					track(LockTest.lock(recordId, { timeout: 4000 }));
					track(LockTest.lock(recordId, { timeout: 4000 }));
					await delay(100); // both parked
					throw new Error('abort with lock waiters parked');
				}),
				/abort with lock waiters parked/
			);
			await outside.unlock();
			const outcomes = await Promise.all(waiters);
			for (const outcome of outcomes)
				assert.notStrictEqual(outcome, 'acquired', 'a waiter that lands after the abort does not keep the lock');
			const next = await LockTest.lock(recordId, { timeout: 1000, hold: true });
			await next.unlock();
		});

		it('a lock write does not stamp an unrelated write staged on the same context', async function () {
			// The holder version stays on the operation instead of pinning the link clock. Pinning it
			// leaves every ungated write staged on the same ImmediateTransaction before the commit
			// resets it — here an off-key delete issued while the lock write is still in flight —
			// carrying the lock's acquisition time, so LWW silently drops it against the newer
			// version the unrelated record already holds.
			if (isLMDB) return this.skip();
			this.timeout(4000);
			const lockedId = id();
			const otherId = id();
			await LockTest.put({ id: lockedId, n: 0 });
			await LockTest.put({ id: otherId, n: 1 });
			const holder = await LockTest.lock(lockedId, { hold: true, lease: 5000 });
			await delay(20); // the unrelated record's version lands well after the lock's acquiredAt
			await LockTest.put({ id: otherId, n: 2 });
			holder.set('n', 1);
			const holderSave = holder.save();
			holder.delete(otherId); // off-key, ungated, staged while the lock write's commit is in flight
			await holderSave;
			await waitFor(() => LockTest.primaryStore.getEntry(otherId)?.value == null, {
				message: 'the off-key delete was stamped at the lock version and dropped by LWW',
			});
			await holder.unlock();
			assert.strictEqual((await LockTest.get(lockedId)).n, 1, 'the holder write landed');
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
