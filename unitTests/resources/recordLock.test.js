const assert = require('assert');
const { Worker } = require('worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');
const { setLockedWriteWaitMs, LOCKED_WRITE_WAIT_MS } = require('#src/resources/recordLock');
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
