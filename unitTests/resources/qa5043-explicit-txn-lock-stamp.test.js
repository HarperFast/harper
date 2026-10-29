const assert = require('node:assert');
const { setupTestDBPath } = require('../../unitTests/testUtils');
const { waitFor } = require('../../unitTests/waitFor');
const { table } = require('#src/resources/databases');
const { localIssuanceRatchet } = require('#src/resources/originClosedFloor');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('QA-5043: explicit transaction lock stamp and version floor contract', function () {
	this.timeout(10000);
	let StampTest;
	let Transaction;
	let originalCommit;
	let nextId = 1;
	const id = () => `qa5043-${nextId++}`;
	const cleanups = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!isLMDB) {
			({ Transaction } = require('../../unitTests/rocksdbBindings.mts').rocksdbBindings());
		}
		StampTest = table({
			table: 'QA5043StampTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'n' },
				{ name: 'updatedAt', type: 'Date', assignUpdatedTime: true },
			],
		});
	});

	afterEach(async function () {
		if (originalCommit && Transaction) Transaction.prototype.commit = originalCommit;
		originalCommit = undefined;
		while (cleanups.length) await cleanups.pop()();
	});

	const stampedEntry = (recordId) => StampTest.primaryStore.getEntry(recordId);
	const putElsewhere = (record) => transaction({}, () => StampTest.put(record));
	const holdLock = async (recordId) => {
		const holder = await StampTest.lock(recordId, { hold: true, lease: 5000 });
		cleanups.push(() => holder.unlock());
		return holder;
	};
	function countCommitAttempts() {
		const db = StampTest.primaryStore.store.db;
		const attempts = new Map();
		const commit = (originalCommit = Transaction.prototype.commit);
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db === db) attempts.set(this.id, (attempts.get(this.id) ?? 0) + 1);
			return commit.apply(this, args);
		};
		return attempts;
	}

	describe('Positive Controls', function () {
		it('C1: LMDB 501 lock contract + plain explicit transaction({ timestamp }) stamps version and updatedAt', async function () {
			if (isLMDB) {
				await assert.rejects(
					() => StampTest.lock(id()),
					(err) => err && err.statusCode === 501,
					'LMDB must reject Table.lock() with statusCode 501'
				);
			}
			const recordId = id();
			const timestamp = Date.now() + 60_000;
			await transaction({ timestamp }, async () => {
				await StampTest.put({ id: recordId, n: 42 });
			});
			const entry = stampedEntry(recordId);
			assert.strictEqual(entry.value.n, 42);
			assert.strictEqual(entry.version, timestamp);
			assert.strictEqual(entry.value.updatedAt.getTime(), timestamp);
		});

		it('C2: harper#3572 control — conflict retry with manual txn.releaseReadTxn() keeps locked write', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			const otherId = id();
			const conflictId = id();
			for (const recordId of [lockedId, otherId, conflictId]) await StampTest.put({ id: recordId, n: 0 });
			const attempts = countCommitAttempts();
			let holder;
			let outerId;
			await transaction(async (txn) => {
				await StampTest.update(otherId, { n: 1 });
				holder = await holdLock(lockedId);
				const acquiredAt = StampTest.primaryStore.rootStore.getMonotonicTimestamp();
				await waitFor(() => StampTest.primaryStore.rootStore.getMonotonicTimestamp() > acquiredAt, 100);
				await putElsewhere({ id: lockedId, n: 50 });
				txn.releaseReadTxn();
				holder.set('n', 100);
				await holder.save();
				await StampTest.put({ id: conflictId, n: 1 });
				outerId = txn.transaction.id;
				await putElsewhere({ id: conflictId, n: 2 });
			});
			assert.ok(attempts.get(outerId) > 1, 'the conflicting write forced a retry');
			const committed = stampedEntry(lockedId);
			assert.strictEqual(committed.value.n, 100);
			assert.strictEqual(committed.version, stampedEntry(otherId).version);
			holder.set('n', 101);
			await holder.save();
			assert.strictEqual(stampedEntry(lockedId).value.n, 101);
			assert.ok(stampedEntry(lockedId).version > committed.version);
		});

		it('C3: harper#3572 control — transaction({ timestamp }) conflict retry and open-iterator replay keep version', async function () {
			if (isLMDB) return this.skip();
			const lockedId1 = id();
			const otherId1 = id();
			await StampTest.put({ id: lockedId1, n: 0 });
			await StampTest.put({ id: otherId1, n: 0 });
			const timestamp1 = Date.now() + 60_000;
			const attempts1 = countCommitAttempts();
			let outerId;
			await transaction({ timestamp: timestamp1 }, async (txn) => {
				const holder = await holdLock(lockedId1);
				holder.set('n', 1);
				await holder.save();
				await StampTest.put({ id: otherId1, n: 1 });
				outerId = txn.transaction.id;
				await putElsewhere({ id: otherId1, n: 2 });
			});
			assert.ok(attempts1.get(outerId) > 1, 'the sibling conflict forced a retry');
			const locked1 = stampedEntry(lockedId1);
			assert.strictEqual(locked1.value.n, 1);
			assert.strictEqual(locked1.version, timestamp1);
			assert.strictEqual(locked1.value.updatedAt.getTime(), timestamp1);

			if (originalCommit) Transaction.prototype.commit = originalCommit;
			originalCommit = undefined;

			const lockedId2 = id();
			const otherId2 = id();
			await StampTest.put({ id: lockedId2, n: 0 });
			await StampTest.put({ id: otherId2, n: 0 });
			const timestamp2 = Date.now() + 65_000;
			const attempts2 = countCommitAttempts();
			let retainedId;
			await transaction({ timestamp: timestamp2 }, async (txn) => {
				const holder = await holdLock(lockedId2);
				holder.set('n', 1);
				await holder.save();
				await StampTest.put({ id: otherId2, n: 1 });
				const iterator = StampTest.search({ conditions: [] }, txn)[Symbol.asyncIterator]();
				cleanups.push(() => iterator.return?.());
				await iterator.next();
				retainedId = txn.transaction.id;
			});
			assert.ok(!attempts2.has(retainedId), 'the writes committed on a replay transaction, not the iterator’s');
			const locked2 = stampedEntry(lockedId2);
			assert.strictEqual(locked2.value.n, 1);
			assert.strictEqual(locked2.version, timestamp2);
			assert.strictEqual(locked2.value.updatedAt.getTime(), timestamp2);
		});
	});

	describe('Contract / Bug Arms (RocksDB)', function () {
		it('Arm 1a: surviving { hold: true } lock acquired before transaction(context, ...), written inside transaction(), then saved outside drops post-txn save', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			await StampTest.put({ id: lockedId, n: 0 });

			// 1. Acquire surviving hold lock on shared context before transaction() (handle.acquiredAt = t0, #lastHolderVersion = undefined)
			const context = {};
			const holder = await StampTest.lock(lockedId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder.unlock());

			// 2. Write through holder inside an explicit transaction(context, ...).
			// Because this DatabaseTransaction has `this.recordLocks === undefined`, commit() skips
			// `noteCommittedLockVersions` (`if (this.recordLocks)` at lines 3088, 3369 and `if (!recordLocks) return` at line 1792),
			// leaving `handle.#lastHolderVersion = undefined` even though lockedId committed at v1 > t0.
			await transaction(context, async () => {
				holder.set('n', 10);
				await holder.save();
			});
			const v1 = stampedEntry(lockedId).version;
			assert.strictEqual(stampedEntry(lockedId).value.n, 10);

			// 3. Subsequent save on the surviving hold stamps `holderVersionCandidate() = acquiredAt = t0 < v1`
			// and is silently dropped by LWW (`precedesExisting < 0` -> `write.skipped = true`).
			holder.set('n', 20);
			await holder.save();

			const finalLocked = stampedEntry(lockedId);
			assert.strictEqual(
				finalLocked.value.n,
				20,
				`Expected post-transaction holder.save() (n: 20) to advance past transaction commit version v1 (${v1}), but got n: ${finalLocked.value.n} (finalVersion=${finalLocked.version})`
			);
			assert.ok(finalLocked.version > v1);
		});

		it('Arm 1b: surviving { hold: true } lock acquired in transaction 1, written in transaction 2, then saved outside drops save', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			const otherId = id();
			await StampTest.put({ id: lockedId, n: 0 });
			await StampTest.put({ id: otherId, n: 0 });

			let holder;
			// 1. Acquire surviving hold in Transaction 1 without writing to lockedId
			await transaction(async () => {
				holder = await holdLock(lockedId);
				await StampTest.put({ id: otherId, n: 1 });
			});

			// 2. Write through surviving hold in Transaction 2 (where `this.recordLocks` is undefined)
			await transaction(async () => {
				holder.set('n', 10);
				await holder.save();
				await StampTest.put({ id: otherId, n: 10 });
			});
			const v1 = stampedEntry(lockedId).version;
			assert.strictEqual(stampedEntry(lockedId).value.n, 10);

			// 3. Subsequent save on surviving hold must advance past v1, not revert to acquiredAt < v1
			holder.set('n', 20);
			await holder.save();

			const finalLocked = stampedEntry(lockedId);
			assert.strictEqual(
				finalLocked.value.n,
				20,
				`Expected holder.save() after Transaction 2 (n: 20) to advance past v1 (${v1}), but got n: ${finalLocked.value.n} (finalVersion=${finalLocked.version})`
			);
			assert.ok(finalLocked.version > v1);
		});

		it('Arm 2a: surviving { hold: true } lock used in subsequent explicit transaction() after future-timestamp write advanced #lastHolderVersion', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			const otherId = id();
			await StampTest.put({ id: lockedId, n: 0 });
			await StampTest.put({ id: otherId, n: 0 });

			const timestamp = Date.now() + 60_000;
			const context = { timestamp };
			let holder;
			await transaction(context, async () => {
				holder = await StampTest.lock(lockedId, { hold: true, lease: 5000 });
				cleanups.push(() => holder.unlock());
				holder.set('n', 10);
				await holder.save();
			});
			assert.strictEqual(stampedEntry(lockedId).value.n, 10);
			assert.strictEqual(stampedEntry(lockedId).version, timestamp);

			// Clear caller timestamp on shared context and run a subsequent explicit transaction() while holder is still held
			delete context.timestamp;
			await transaction(context, async () => {
				holder.set('n', 20);
				await holder.save();
				await StampTest.put({ id: otherId, n: 20 });
			});

			const afterSecondTxn = stampedEntry(lockedId);
			const otherEntry = stampedEntry(otherId);
			assert.strictEqual(
				afterSecondTxn.value.n,
				20,
				`Expected surviving hold's write in subsequent explicit transaction() to advance past #lastHolderVersion (${timestamp}), but got n: ${afterSecondTxn.value.n} (locked.version=${afterSecondTxn.version}, other.version=${otherEntry.version})`
			);
			assert.ok(afterSecondTxn.version > timestamp);
		});

		it('Arm 2b: surviving { hold: true } lock across mid-scope await txn.commit() in transaction({ timestamp })', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			await StampTest.put({ id: lockedId, n: 0 });

			const timestamp = Date.now() + 60_000;
			let seg1Version;
			let seg2TxnTimestampBeforeSave;
			let seg2TxnTimestampAfterSave;
			await transaction({ timestamp }, async (txn) => {
				const holder = await holdLock(lockedId);
				holder.set('n', 10);
				await holder.save();
				await txn.commit();
				seg1Version = stampedEntry(lockedId).version;
				assert.strictEqual(stampedEntry(lockedId).value.n, 10);
				assert.strictEqual(seg1Version, timestamp);

				seg2TxnTimestampBeforeSave = txn.timestamp;
				holder.set('n', 20);
				await holder.save();
				seg2TxnTimestampAfterSave = txn.timestamp;
			});

			const finalLocked = stampedEntry(lockedId);
			assert.strictEqual(
				finalLocked.value.n,
				20,
				`Expected segment 2 write n: 20 after mid-scope txn.commit() in transaction({ timestamp: ${timestamp} }) to land, but got n: ${finalLocked.value.n} (seg1Version=${seg1Version}, finalVersion=${finalLocked.version}, seg2TxnTimestampBeforeSave=${seg2TxnTimestampBeforeSave}, seg2TxnTimestampAfterSave=${seg2TxnTimestampAfterSave})`
			);
			assert.ok(finalLocked.version > seg1Version);
		});

		it('holderVersionFloor() is side-effect-free and common reused hold at normal time does not ratchet', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			await StampTest.put({ id: lockedId, n: 0 });
			const rootStore = StampTest.primaryStore.rootStore;
			const context = {};
			const holder = await StampTest.lock(lockedId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder.unlock());
			const handle = [...context.transaction.recordLocks.values()][0].values().next().value;
			assert.strictEqual(handle.holderVersionFloor(), handle.acquiredAt);

			await transaction(context, async () => {
				holder.set('n', 1);
				await holder.save();
			});
			const v1 = stampedEntry(lockedId).version;
			await waitFor(() => rootStore.getMonotonicTimestamp() > handle.holderVersionFloor(), 100);

			const ratchetBefore = localIssuanceRatchet(rootStore);
			const floor = handle.holderVersionFloor();
			assert.ok(floor > v1, 'holderVersionFloor steps above last committed holder version');
			assert.strictEqual(localIssuanceRatchet(rootStore), ratchetBefore, 'holderVersionFloor does not advance ratchet');

			await transaction(context, async (txn) => {
				holder.set('n', 2);
				await holder.save();
				assert.ok(
					!txn.transaction.reservedAroundCallerValue,
					'reused hold whose floor is behind the monotonic clock does not force a caller-timestamp reservation'
				);
			});
			assert.strictEqual(stampedEntry(lockedId).value.n, 2);
			assert.ok(stampedEntry(lockedId).version > v1);
			assert.strictEqual(localIssuanceRatchet(rootStore), ratchetBefore);
		});

		it('refuses with 409 when an explicit transaction fixed its clock below a surviving hold floor', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			const otherId = id();
			const highHoldId = id();
			const lowHoldId = id();
			for (const recordId of [lockedId, otherId, highHoldId, lowHoldId]) await StampTest.put({ id: recordId, n: 0 });

			const futureTs = Date.now() + 60_000;
			const contextA = { timestamp: futureTs };
			let holder;
			await transaction(contextA, async () => {
				holder = await StampTest.lock(lockedId, { hold: true, lease: 5000 });
				cleanups.push(() => holder.unlock());
				holder.set('n', 10);
				await holder.save();
			});
			assert.strictEqual(stampedEntry(lockedId).version, futureTs);

			// Case A: an earlier unlocked write fixed the transaction clock before holder.save()
			delete contextA.timestamp;
			await transaction(contextA, async () => {
				await StampTest.update(otherId, { n: 1 });
				holder.set('n', 20);
				await assert.rejects(
					async () => holder.save(),
					(err) => err && err.statusCode === 409
				);
			});
			assert.strictEqual(stampedEntry(otherId).value.n, 1, 'earlier unlocked write still commits after caught 409');
			assert.strictEqual(stampedEntry(lockedId).value.n, 10, 'refused hold write did not land');

			// Case B: an earlier lower-floor hold write already reserved the transaction log key below holderHigh's floor
			const contextB = { timestamp: futureTs + 1000 };
			let holderHigh;
			await transaction(contextB, async () => {
				holderHigh = await StampTest.lock(highHoldId, { hold: true, lease: 5000 });
				cleanups.push(() => holderHigh.unlock());
				holderHigh.set('n', 15);
				await holderHigh.save();
			});
			delete contextB.timestamp;
			const holderLow = await StampTest.lock(lowHoldId, { hold: true, lease: 5000 }, contextB);
			cleanups.push(() => holderLow.unlock());

			await transaction(contextB, async () => {
				holderLow.set('n', 2);
				await holderLow.save();
				holderHigh.set('n', 25);
				await assert.rejects(
					async () => holderHigh.save(),
					(err) => err && err.statusCode === 409
				);
			});
			assert.strictEqual(stampedEntry(lowHoldId).value.n, 2, 'earlier hold write commits cleanly after caught 409');
			assert.strictEqual(stampedEntry(highHoldId).value.n, 15, 'second hold write with higher floor was refused');
		});

		it('advances #lastHolderVersion across ImmediateTransaction saves even when transaction.recordLocks is absent', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			await StampTest.put({ id: lockedId, n: 0 });

			const context = {};
			const holder = await StampTest.lock(lockedId, { hold: true, lease: 5000 }, context);
			cleanups.push(() => holder.unlock());
			// Simulate a transaction link that did not itself call registerRecordLock
			context.transaction.recordLocks = undefined;

			holder.set('n', 1);
			await holder.save();
			const v1 = stampedEntry(lockedId).version;
			assert.strictEqual(stampedEntry(lockedId).value.n, 1);

			holder.set('n', 2);
			await holder.save();
			const v2 = stampedEntry(lockedId).version;
			assert.strictEqual(stampedEntry(lockedId).value.n, 2);
			assert.ok(v2 > v1, 'second immediate save advanced past v1 via write.lockHandle');
		});

		it('conflict retry after open-explicit-transaction floor adoption keeps the adopted version', async function () {
			if (isLMDB) return this.skip();
			const lockedId = id();
			const conflictId = id();
			await StampTest.put({ id: lockedId, n: 0 });
			await StampTest.put({ id: conflictId, n: 0 });

			const futureTs = Date.now() + 60_000;
			const context = { timestamp: futureTs };
			let holder;
			await transaction(context, async () => {
				holder = await StampTest.lock(lockedId, { hold: true, lease: 5000 });
				cleanups.push(() => holder.unlock());
				holder.set('n', 10);
				await holder.save();
			});

			delete context.timestamp;
			const attempts = countCommitAttempts();
			let outerId;
			await transaction(context, async (txn) => {
				holder.set('n', 20);
				await holder.save();
				await StampTest.put({ id: conflictId, n: 1 });
				outerId = txn.transaction.id;
				await putElsewhere({ id: conflictId, n: 2 });
			});
			assert.ok(attempts.get(outerId) > 1, 'the conflicting write forced a retry');
			const finalLocked = stampedEntry(lockedId);
			assert.strictEqual(finalLocked.value.n, 20);
			assert.ok(finalLocked.version > futureTs);
			assert.strictEqual(stampedEntry(conflictId).version, finalLocked.version);
		});
	});
});
