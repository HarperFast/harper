const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { ImmediateTransaction } = require('#src/resources/DatabaseTransaction');
const { MIN_LOCK_LEASE_MS } = require('#src/resources/recordLock');
const { transaction } = require('#src/resources/transaction');
require('#src/server/serverHelpers/serverUtilities');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Conflict retries of writes that commit per write; the invariant is in resources/DESIGN.md.
describe('ImmediateTransaction conflict retry', () => {
	let Locked;
	let nextId = 1;
	const id = () => `retry-${nextId++}`;
	const pendingRestores = [];
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Locked = table({
			table: 'ImmediateConflictRetry',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
			audit: true,
		});
		process.on('unhandledRejection', onUnhandled);
	});
	after(() => process.removeListener('unhandledRejection', onUnhandled));
	afterEach(async () => {
		while (pendingRestores.length) pendingRestores.pop()();
		await delay(20); // a rejection raised after a test's last assertion still fails that test
		assert.deepStrictEqual(unhandled.splice(0), []);
	});

	// ERR_BUSY on the first `failFirst` native commits against the test table's db, then real commits;
	// records the native transaction id of every attempt so the test can see which transaction each
	// retry used. `beforeReject` runs before the first rejection, to age the holder's lease meanwhile.
	function conflictCommits({ failFirst = 1, beforeReject } = {}) {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = Locked.primaryStore.store.db;
		const attempts = [];
		const aborted = [];
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
			attempts.push(this.id);
			if (attempts.length > failFirst) return originalCommit.apply(this, args);
			if (attempts.length === 1) await beforeReject?.();
			throw Object.assign(new Error('forced conflict'), { code: 'ERR_BUSY' });
		};
		const originalAbort = Transaction.prototype.abort;
		Transaction.prototype.abort = function (...args) {
			const result = originalAbort.apply(this, args);
			if (this.store?.db === targetDb) aborted.push(this.id);
			return result;
		};
		pendingRestores.push(() => {
			Transaction.prototype.commit = originalCommit;
			Transaction.prototype.abort = originalAbort;
		});
		return { attempts, aborted };
	}
	const auditEntriesFor = (recordId) =>
		[...Locked.auditStore.getRange({ start: 1 })].filter(
			(entry) => entry.tableId === Locked.tableId && entry.recordId === recordId
		).length;

	async function assertNoUnhandledRejection() {
		await delay(20); // unhandledRejection is emitted a turn after the rejection
		assert.deepStrictEqual(unhandled, []);
	}

	it('retries a conflicting hold-lock save on the transaction it was committing, not a nested commit', async function () {
		if (isLMDB) return this.skip();
		const recordId = id();
		await Locked.put({ id: recordId, n: 0 });
		const holder = await Locked.lock(recordId, { hold: true, lease: 5000 });
		assert.ok(
			holder.getContext().transaction instanceof ImmediateTransaction,
			'premise: a hold save commits per write'
		);
		const auditBefore = auditEntriesFor(recordId);
		const { attempts } = conflictCommits();
		holder.set('n', 7);
		await holder.save();
		assert.strictEqual(Locked.primaryStore.getEntry(recordId).value.n, 7, 'the retried write landed');
		assert.deepStrictEqual(attempts, [attempts[0], attempts[0]], 'one conflict, one retry, same native transaction');
		assert.strictEqual(
			auditEntriesFor(recordId) - auditBefore,
			1,
			'the retry re-staged the record, not a second audit entry'
		);
		await assertNoUnhandledRejection();
		await holder.unlock();
	});

	it('retries a real RocksDB conflict: a plain write landing during the hold wins by LWW, and the save resolves', async function () {
		if (isLMDB) return this.skip();
		const recordId = id();
		await Locked.put({ id: recordId, n: 0 });
		const holder = await Locked.lock(recordId, { hold: true, lease: 5000 });
		// The incident's shape: the holder's write is staged, then a plain write to the same key commits
		// before the holder's native commit runs, so RocksDB itself refuses that commit.
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = Locked.primaryStore.store.db;
		const attempts = [];
		let interposed = false;
		Transaction.prototype.commit = async function (...args) {
			if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
			attempts.push(this.id);
			if (!interposed) {
				interposed = true;
				await Locked.put({ id: recordId, n: 100 });
			}
			return originalCommit.apply(this, args);
		};
		pendingRestores.push(() => (Transaction.prototype.commit = originalCommit));
		holder.set('n', 7);
		await holder.save();
		const holderCommits = attempts.filter((txnId) => txnId === attempts[0]);
		assert.strictEqual(holderCommits.length, 2, `the holder's transaction was retried once: ${attempts}`);
		assert.strictEqual(attempts.length, 3, 'one interposed plain write, no extra transactions');
		assert.strictEqual(Locked.primaryStore.getEntry(recordId).value.n, 100, 'the later plain write wins by LWW');
		await assertNoUnhandledRejection();
		await holder.unlock();
	});

	it('rejects the awaited save once a persistent conflict spends the commit budget', async function () {
		if (isLMDB) return this.skip();
		const recordId = id();
		await Locked.put({ id: recordId, n: 0 });
		const holder = await Locked.lock(recordId, { hold: true, lease: 5000 });
		const immediate = holder.getContext().transaction;
		// The budget clock is stamped at the first native submission only when unset, so a value
		// planted here is what the retry site reads (the same device commitConflictDeadline.test.js uses).
		immediate.commitStartedAt = performance.now() - 3600000;
		const { attempts, aborted } = conflictCommits({ failFirst: Infinity });
		holder.set('n', 7);
		await assert.rejects(
			() => holder.save(),
			(error) => error.statusCode === 503 && /in conflict with ongoing writes/.test(error.message)
		);
		assert.deepStrictEqual(attempts, [attempts[0]], 'abandoned on the first conflict: no second transaction opened');
		assert.ok(aborted.includes(attempts[0]), 'the abandoned native transaction was released');
		assert.strictEqual(Locked.primaryStore.getEntry(recordId).value.n, 0, 'nothing landed');
		assert.strictEqual(immediate.isCommitting, false, 'the latch clears, so the next save on this context commits');
		await assertNoUnhandledRejection();
		await holder.unlock();
	});

	it('refuses the retry with 409 when the lease expires while the first attempt conflicts', async function () {
		if (isLMDB) return this.skip();
		const recordId = id();
		await Locked.put({ id: recordId, n: 0 });
		const lease = MIN_LOCK_LEASE_MS;
		const holder = await Locked.lock(recordId, { hold: true, lease });
		const { attempts, aborted } = conflictCommits({ beforeReject: () => delay(lease + 50) });
		holder.set('n', 7);
		await assert.rejects(
			() => holder.save(),
			(error) => error.statusCode === 409
		);
		assert.deepStrictEqual(attempts, [attempts[0]], 'the retry was refused before a second commit');
		assert.ok(aborted.includes(attempts[0]), 'the refused native transaction was released');
		assert.strictEqual(Locked.primaryStore.getEntry(recordId).value.n, 0, 'a stale holder write never lands');
		await assertNoUnhandledRejection();
	});

	it('releases the replay transaction when a lapsed lease refuses a re-save forced by an open iterator', async function () {
		if (isLMDB) return this.skip();
		const recordId = id();
		await Locked.put({ id: recordId, n: 0 });
		const { aborted } = conflictCommits({ failFirst: 0 });
		const lease = MIN_LOCK_LEASE_MS;
		await assert.rejects(
			transaction(async (context) => {
				const record = await Locked.lock(recordId, { lease });
				record.set('n', 7);
				await record.save();
				// An open read iterator at commit forces every staged write onto a replay transaction.
				const iterator = Locked.search({ conditions: [] }, context)[Symbol.asyncIterator]();
				await iterator.next();
				await delay(lease + 50);
			}),
			(error) => error.statusCode === 409
		);
		assert.strictEqual(
			aborted.length,
			2,
			`the replay transaction and the retained read handle were released: ${aborted}`
		);
		assert.strictEqual(Locked.primaryStore.getEntry(recordId).value.n, 0, 'a stale holder write never lands');
		await assertNoUnhandledRejection();
	});
});
