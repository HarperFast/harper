const assert = require('assert');
const { Worker } = require('worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { setLockedWriteWaitMs, LOCKED_WRITE_WAIT_MS, MIN_LOCK_LEASE_MS } = require('#src/resources/recordLock');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Exclusive record locks (harper#483, Phase 0): the native key lock (rocksdb-js process-wide lock
// map) is the sole authority. lock() and unlock() write nothing to the store or audit log. The
// record's version and stored bytes are unchanged by acquiring or releasing a lock.
describe('Record locks (harper#483)', () => {
	let LockTest;
	let LockTestTimed; // table with assignUpdatedTime to verify restage timestamp propagation
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
		LockTestTimed = table({
			table: 'RecordLockTestTimed',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: '__updatedtime__', type: 'number', assignUpdatedTime: true },
			],
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

		it('re-stages a holder write past an ungated rewrite that moved the record during the critical section', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1, name: 'start' });
			let movedVersion;
			await transaction(async () => {
				const record = await LockTest.lock(recordId);
				const versionAtLock = entryOf(recordId).version;
				// a canonical-source apply is never gated; it carries the record forward and bumps the version
				await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 50, name: 'source' }));
				const moved = entryOf(recordId);
				movedVersion = moved.version;
				assert.strictEqual(moved.value.n, 50, 'the source apply landed while the lock was held');
				assert.ok(movedVersion > versionAtLock, 'and moved the record past the lock timestamp');
				record.set('n', 7);
				await record.save();
			});
			const final = entryOf(recordId);
			assert.strictEqual(final.value.n, 7, 'the holder write is not lost below the moved version');
			assert.ok(final.version > movedVersion, 'and landed as the newest version');
		});
	});

	describe('write gate', () => {
		it('delays a non-holder put until the release, then applies it without losing the holder write', async function () {
			if (isLMDB) return this.skip();
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
		});

		it('gates a delete and an update too', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const holder = await LockTest.lock(recordId, { hold: true });
			const deletion = LockTest.delete(recordId);
			assert.strictEqual(await settlement(deletion), 'pending');
			await holder.unlock();
			await deletion;
			assert.ok((await LockTest.get(recordId)) == null, 'deleted after the release');
		});

		it('gates the creation of a locked absent id', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			const holder = await LockTest.lock(recordId, { hold: true });
			assert.ok((await LockTest.get(recordId)) == null, 'no record exists');
			assert.ok(entryOf(recordId) == null, 'no placeholder written to the store');
			const creation = LockTest.create({ id: recordId, n: 1 });
			assert.strictEqual(await settlement(creation), 'pending');
			holder.set('n', 100);
			await holder.save();
			assert.strictEqual((await LockTest.get(recordId)).n, 100, 'the holder created it');
			await holder.unlock();
			await creation;
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'then the delayed create applied');
		});

		it('gates a non-holder publish; the holder can still invalidate without waiting', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 1 });
			const holder = await LockTest.lock(recordId, { hold: true });
			const published = LockTest.publish(recordId, { hello: 'world' });
			assert.strictEqual(await settlement(published), 'pending', 'a message rewrites the version, so it waits');
			// holder's own invalidate is re-entrant via recordLocks and proceeds without waiting
			await holder.invalidate();
			await holder.unlock();
			await published;
		});

		it('two writes to the same gated key in one transaction both land without hanging (CLAIM 2)', async function () {
			// Gemini CLAIM 2: waitForPendingKeys iterates allGateEligible (which may contain two entries
			// for the same key), and the second entry awaits its own pendingWake even though the first
			// iteration already acquired the key, parking until the 423 deadline.
			// Prove it does not hang: a transaction with put(K) + patch(K) + put(L) behind a 300ms holder
			// must commit well within 2 s.
			if (isLMDB) return this.skip();
			this.timeout(2000);
			const idK = id();
			const idL = id();
			await LockTest.put({ id: idK, n: 0, name: 'k-orig' });
			await LockTest.put({ id: idL, n: 0 });
			const holder = await LockTest.lock(idK, { hold: true, lease: 300 });
			const t0 = Date.now();
			const txPromise = transaction(async () => {
				// Two writes to the same gated key K plus one to L.
				await LockTest.put({ id: idK, n: 1 });
				await LockTest.put({ id: idK, n: 2 }); // overwrites the first; same key
				await LockTest.put({ id: idL, n: 9 });
			});
			assert.strictEqual(await settlement(txPromise, 50), 'pending', 'transaction parked on holder');
			await holder.unlock();
			await txPromise;
			const elapsed = Date.now() - t0;
			assert.ok(elapsed < 1500, `transaction took ${elapsed}ms — expected < 1500ms (not hanging)`);
			assert.strictEqual((await LockTest.get(idK)).n, 2, 'K final write landed');
			assert.strictEqual((await LockTest.get(idL)).n, 9, 'L write landed');
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

		it('fails a waiting lock() with 423 at its timeout', async function () {
			if (isLMDB) return this.skip();
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

		it('an expired holder write fails with 409 while another party holds the record', async function () {
			if (isLMDB) return this.skip();
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

		it('abort during pendingWake cancels the park and strands no handle', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });

			// Stage a put inside a transaction scope so we can abort the scope externally
			let parkTxn;
			const parked = transaction((txn) => {
				parkTxn = txn;
				LockTest.put({ id: recordId, n: 1 });
			});

			// Give the commit one tick to enter waitForPendingKeys and park on the wake promise
			await new Promise((r) => setImmediate(r));
			assert.ok(parkTxn, 'transaction was captured');
			parkTxn.abort();

			await assert.rejects(
				() => parked,
				(err) => err.statusCode === 500
			);
			// No handle was stranded: after the holder releases, a fresh put succeeds immediately
			await holder.unlock();
			await LockTest.put({ id: recordId, n: 2 });
			assert.strictEqual((await LockTest.get(recordId)).n, 2, 'fresh put succeeded, no stranded handle');
		});

		it('a 423 from a locked write releases gate locks and aborts the transaction', async function () {
			if (isLMDB) return this.skip();
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 0 });
			await LockTest.put({ id: idB, n: 0 });
			const bHolder = await LockTest.lock(idB, { hold: true, lease: 5000 });
			setLockedWriteWaitMs(100);
			let failedErr;
			try {
				await transaction(async () => {
					await LockTest.put({ id: idA, n: 1 });
					await LockTest.put({ id: idB, n: 1 });
				});
			} catch (err) {
				failedErr = err;
			} finally {
				setLockedWriteWaitMs(LOCKED_WRITE_WAIT_MS);
			}
			assert.ok(failedErr?.statusCode === 423, `expected 423, got ${failedErr?.statusCode}`);
			// Pre-423 write to A must not have landed (transaction was aborted)
			assert.strictEqual((await LockTest.get(idA)).n, 0, 'A write was rolled back with the transaction');
			// A's gate lock must have been released; a fresh write should proceed without blocking
			await LockTest.put({ id: idA, n: 2 });
			assert.strictEqual((await LockTest.get(idA)).n, 2, 'A is writable after the failed transaction');
			await bHolder.unlock();
		});

		it('a 409 from an expired holder strands no gate handles on sibling keys', async function () {
			if (isLMDB) return this.skip();
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 0 });
			await LockTest.put({ id: idB, n: 0 });
			const expired = await LockTest.lock(idB, { hold: true, lease: 100 });
			await delay(150);
			const currentHolder = await LockTest.lock(idB, { hold: true });
			await assert.rejects(
				() =>
					transaction(async () => {
						await LockTest.put({ id: idA, n: 1 });
						expired.set('n', 99);
						await expired.save();
					}),
				(err) => err.statusCode === 409
			);
			// A's gate handle must have been released; a fresh write must not block.
			await LockTest.put({ id: idA, n: 2 });
			assert.strictEqual((await LockTest.get(idA)).n, 2, 'A writable after 409');
			await currentHolder.unlock();
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

		it('a 423 from an expired deadline releases gate handles without waiting for a park', async function () {
			// Hits the waitForPendingKeys entry-check 423 (lockWaitDeadline already elapsed on first call).
			if (isLMDB) return this.skip();
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 0 });
			await LockTest.put({ id: idB, n: 0 });
			const bHolder = await LockTest.lock(idB, { hold: true, lease: 5000 });
			setLockedWriteWaitMs(0); // deadline = now + 0 = now → entry check fires immediately
			try {
				await transaction(async () => {
					await LockTest.put({ id: idA, n: 1 }); // gates A
					await LockTest.put({ id: idB, n: 1 }); // gated on B
				});
				assert.fail('expected 423');
			} catch (err) {
				assert.strictEqual(err.statusCode, 423, `expected 423, got ${err.statusCode}`);
			} finally {
				setLockedWriteWaitMs(LOCKED_WRITE_WAIT_MS);
				await bHolder.unlock();
			}
			// A's gate handle must be released; a fresh write must proceed without blocking.
			await LockTest.put({ id: idA, n: 2 });
			assert.strictEqual((await LockTest.get(idA)).n, 2, 'A writable after 423 entry-check');
		});

		it('a gated write converges after the holder commits and does not trigger restageHolderWrites', async function () {
			// Root cause: gateLockedWrite re-entry path (line 545) fired for gate handles (hold=false),
			// setting operation.restage=true regardless.  In multi-threaded CI an ungated concurrent write
			// keeps entry.version > txnTime on every round, causing commit→restageHolderWrites→
			// restageAfter→commit→… to recurse until stack overflow.
			// Fix: the re-entry restage path only runs for hold=true handles; gate handles return false.
			if (isLMDB) return this.skip();
			this.timeout(1000); // loop would exhaust this before completing
			const recordId = id();
			await LockTest.put({ id: recordId, n: 0 });
			const holder = await LockTest.lock(recordId, { hold: true, lease: 5000 });
			// Stage a gated write — parks because the hold handle owns the key.
			const gatedPut = LockTest.put({ id: recordId, n: 99 });
			assert.strictEqual(await settlement(gatedPut, 100), 'pending', 'put is parked on holder');
			// An ungated sourceApply commits to K while the gated write parks.
			// Without fix 1 the gate handle re-entry restage path fires after waitForPendingKeys acquires
			// the lock, potentially looping as ungated writers keep the entry version ahead of txnTime.
			await transaction({ sourceApply: true }, () => LockTest.put({ id: recordId, n: 1 }));
			const versionAfterUngated = LockTest.primaryStore.getEntry(recordId).version;
			await holder.unlock();
			// Must converge without stack overflow; gated write wins (last-writer semantics).
			await gatedPut;
			const entry = LockTest.primaryStore.getEntry(recordId);
			assert.strictEqual(entry.value.n, 99, 'gated write landed past the ungated write');
			assert.ok(entry.version > versionAfterUngated, 'version is newer than the ungated write');
		});

		it('a holder write restaged past an ungated rewrite carries the restaged timestamp as updatedTime', async function () {
			// A sourceApply write bypasses the gate; it moves the record forward while the lock is held.
			// The holder's subsequent write must restage and re-run validate() so __updatedtime__ reflects
			// the restaged txnTime, not the pre-restage timestamp.
			if (isLMDB) return this.skip();
			const recordId = id();
			await LockTestTimed.put({ id: recordId, n: 0 });
			let ungatedVersion;
			await transaction(async () => {
				const holder = await LockTestTimed.lock(recordId);
				// sourceApply is never gated — it moves the record past the holder's txnTime.
				await transaction({ sourceApply: true }, () => LockTestTimed.put({ id: recordId, n: 1 }));
				ungatedVersion = LockTestTimed.primaryStore.getEntry(recordId).version;
				// Holder write triggers restage; validate() must re-run with the new txnTime.
				holder.set('n', 2);
				await holder.save();
			});
			const record = await LockTestTimed.get(recordId);
			assert.strictEqual(record.n, 2, 'holder write landed');
			assert.ok(
				record.__updatedtime__ > ungatedVersion,
				`updatedTime ${record.__updatedtime__} must be after ungated version ${ungatedVersion}`
			);
		});
	});

	describe('deadlock prevention and successive parks', function () {
		it('cross-writes {A,B} and {B,A} both commit without livelock (single-thread cooperative scheduling)', async function () {
			// Single-thread scheduling cannot force the symmetric interleaving that would expose livelock
			// in a real multi-thread run; this test asserts the outcome (both 'ok') rather than proving
			// the acquire loop was entered simultaneously. Livelock would manifest as 503 (max retries),
			// so assertion failures indicate the canonical-acquire-order invariant is broken.
			if (isLMDB) return this.skip();
			this.timeout(5000);
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 0 });
			await LockTest.put({ id: idB, n: 0 });
			const holderA = await LockTest.lock(idA, { hold: true, lease: 10000 });
			const holderB = await LockTest.lock(idB, { hold: true, lease: 10000 });
			const t1 = transaction(async () => {
				await LockTest.put({ id: idA, n: 1 });
				await LockTest.put({ id: idB, n: 1 });
			}).then(
				() => 'ok',
				(e) => e
			);
			const t2 = transaction(async () => {
				await LockTest.put({ id: idB, n: 2 });
				await LockTest.put({ id: idA, n: 2 });
			}).then(
				() => 'ok',
				(e) => e
			);
			// Heuristic pause so both transactions have time to stage and park before we release.
			await delay(50);
			await holderA.unlock();
			await holderB.unlock();
			const [res1, res2] = await Promise.all([t1, t2]);
			assert.strictEqual(res1, 'ok', `T1 failed: ${res1?.message ?? res1}`);
			assert.strictEqual(res2, 'ok', `T2 failed: ${res2?.message ?? res2}`);
			const finalA = (await LockTest.get(idA)).n;
			const finalB = (await LockTest.get(idB)).n;
			assert.ok(finalA === 1 || finalA === 2, `A=${finalA} is not from either transaction`);
			assert.ok(finalB === 1 || finalB === 2, `B=${finalB} is not from either transaction`);
		});

		it('successive parks on two keys commit after each release (single-thread cooperative scheduling)', async function () {
			// Asserts the commit outcome (both n=99); does not verify the internal park count.
			// holderB = await LockTest.lock(idB) succeeding immediately after T starts is the observable
			// that proves T's gate on B was already released before T parked on A.
			if (isLMDB) return this.skip();
			this.timeout(5000);
			const idA = id();
			const idB = id();
			await LockTest.put({ id: idA, n: 0 });
			await LockTest.put({ id: idB, n: 0 });
			const holderA = await LockTest.lock(idA, { hold: true, lease: 10000 });
			const ctx = {};
			const commit = transaction(ctx, async () => {
				await LockTest.put({ id: idA, n: 99 });
				await LockTest.put({ id: idB, n: 99 });
			});
			const holderB = await LockTest.lock(idB, { hold: true, lease: 10000 });
			await holderA.unlock();
			await holderB.unlock();
			await commit;
			assert.strictEqual((await LockTest.get(idA)).n, 99);
			assert.strictEqual((await LockTest.get(idB)).n, 99);
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
			// Without MAJOR-3 fix: after _writeUpdate commits on an ImmediateTransaction the when()
			// callback re-enters save() indefinitely, submitting empty native commits in a loop.
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
				// A write to the same key must use the live handle — not the expired one — and not throw 409.
				await LockTest.put({ id: recordId, n: 1 });
			});
			assert.strictEqual((await LockTest.get(recordId)).n, 1, 'write committed');
		});
	});

	describe('performance: gate-handle registry is O(1) per lookup', function () {
		it('5000-write transaction completes in bounded time (O(N) with Map registry)', async function () {
			// A quadratic (O(N²)) registry would hit ~12M iterations at N=5000, easily exceeding 5 s.
			if (isLMDB) return this.skip();
			this.timeout(10000);
			const N = 5000;
			const ids = Array.from({ length: N }, () => id());
			// Seed without gating so the seed itself is not subject to the registry scan cost.
			await transaction({ sourceApply: true }, async () => {
				for (const rid of ids) await LockTest.put({ id: rid, n: 0 });
			});
			const t0 = Date.now();
			await transaction(async () => {
				for (const rid of ids) await LockTest.put({ id: rid, n: 1 });
			});
			const elapsed = Date.now() - t0;
			assert.ok(elapsed < 5000, `5000-write transaction took ${elapsed}ms — expected < 5000ms`);
			assert.strictEqual((await LockTest.get(ids[0])).n, 1, 'first record committed');
			assert.strictEqual((await LockTest.get(ids[N - 1])).n, 1, 'last record committed');
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

		it('a terminated worker thread releases its held lock', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await ThreadTable.put({ id: recordId, n: 1 });
			// Start a fresh worker (outside the reusable pool) so we can terminate it cleanly
			const dying = new Worker(__dirname + '/recordLock-thread.js', { workerData: { addPorts: [] } });
			await request(dying, { type: 'hold', id: recordId, lease: 30_000 }, 'held');
			// Verify the lock is actually held before we terminate
			const put = ThreadTable.put({ id: recordId, n: 2 });
			assert.strictEqual(await settlement(put), 'pending', 'put is blocked by the dying worker');
			await dying.terminate();
			// rocksdb-js ~DBHandle() calls lockReleaseByOwner; the put should now proceed
			await put;
			assert.strictEqual((await ThreadTable.get(recordId)).n, 2, 'put landed after the worker died');
		});

		it('a lock held on another thread gates this thread until it is released', async function () {
			if (isLMDB) return this.skip();
			const recordId = id();
			await ThreadTable.put({ id: recordId, n: 1 });
			await request(workers[0], { type: 'hold', id: recordId, lease: 5000 }, 'held');
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
