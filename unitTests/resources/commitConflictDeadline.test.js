require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getOutstandingCommits } = require('#src/resources/DatabaseTransaction');
const { waitFor } = require('../waitFor');
const { setTimeout: delay } = require('node:timers/promises');
const RETRY_NOW_VALUE = require('@harperfast/rocksdb-js').constants.RETRY_NOW_VALUE;

// rocksdb-js parks a coordinated-retry commit on a conflicting write intent and returns control
// after a bounded wait even when the holder never releases, so Harper sees a long stream of
// transient conflicts rather than one commit that hangs. The attempt cap alone then keeps a
// request pending for tens of attempts — minutes past the queue limit an operator configured, which
// is what left a control-plane node 503ing every write for 12 minutes in harper#2450. These pin the
// elapsed deadline that bounds it: one clock per LOGICAL commit, carried on the chain root so
// retries and chained stores share it, and a distinct 503 that says the conflict was transient.
describe('request-path commits are abandoned once their conflict budget is spent', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	// Larger than any configured storage.maxTransactionQueueTime this suite could run under, so the
	// budget is spent at the first retry decision and the test never waits real seconds for it.
	const WELL_PAST_BUDGET_MS = 3600000;
	let DeadlineA, DeadlineB;
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);
	const pendingRestores = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		DeadlineA = table({
			table: 'CommitDeadlineA',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
			audit: true,
		});
		// A different database, deliberately: txnForContext() only builds the `transaction.next` chain
		// across databases, and the chained link is where "an earlier store already committed" arises.
		DeadlineB = table({
			table: 'CommitDeadlineB',
			database: 'testCommitDeadline',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		process.on('unhandledRejection', onUnhandled);
	});

	after(() => {
		process.removeListener('unhandledRejection', onUnhandled);
	});

	afterEach(async () => {
		while (pendingRestores.length) pendingRestores.pop()();
		// unhandledRejection is emitted a turn after the rejection itself, so drain before asserting
		await delay(50);
		assert.deepEqual(unhandled, [], 'abandonment must not leak an unhandled rejection');
		unhandled.length = 0;
	});

	// Force native commits against ONE table's database to report a conflict: `retryNow` resolves with
	// the coordinatedRetry sentinel, `reject` rejects with the uncoordinated conflict code. Scoped to
	// that database's handle because background timers (hdb_analytics) commit their own transactions
	// during these tests. `failFirst` releases the stub after N attempts so an uncapped (source-apply)
	// retry can still converge.
	function conflictCommits(targetTable, mode, { code, failFirst = Infinity } = {}) {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = targetTable.primaryStore.store.db;
		const attempts = [];
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db !== targetDb || attempts.length >= failFirst) return originalCommit.apply(this, args);
			attempts.push(this.id);
			if (mode === 'retryNow') return Promise.resolve(RETRY_NOW_VALUE);
			return Promise.reject(Object.assign(new Error('forced conflict'), { code }));
		};
		const restore = () => (Transaction.prototype.commit = originalCommit);
		pendingRestores.push(restore);
		return { attempts, restore };
	}

	// Stage the writes, then pre-age the chain root's clock to simulate a commit that has already
	// been conflicting for longer than its budget. The clock is stamped at the first native
	// submission and only when unset, so a value planted here is the one the retry sites read.
	async function writePastBudget(id, stage) {
		const context = {};
		return transaction(context, async () => {
			await stage(context, id);
			context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
		});
	}

	async function outcomeOf(promise) {
		try {
			await promise;
			return { outcome: 'committed' };
		} catch (error) {
			return { outcome: 'rejected', error };
		}
	}

	const singleStoreWrite = async (context, id) => {
		// read first so the transaction is created through getReadTxn (coordinatedRetry), the shape a
		// request-path write actually takes
		await DeadlineA.get(id, context);
		await DeadlineA.put({ id, name: 'deadline' }, context);
	};

	// Every other case here plants the clock, so without this one the single line that ARMS the
	// deadline in production could be deleted and the suite would stay green while the feature became
	// a no-op: `elapsedPastCommitBudget()` would read `undefined` and every commit would fall back to
	// the attempt cap.
	it('arms the budget clock on the first native submission and releases it when the commit settles', async function () {
		this.timeout(15000);
		let releaseCommit;
		const held = new Promise((resolve) => (releaseCommit = resolve));
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = DeadlineA.primaryStore.store.db;
		let holdNext = true;
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db !== targetDb || !holdNext) return originalCommit.apply(this, args);
			holdNext = false;
			return held.then(() => originalCommit.apply(this, args));
		};
		pendingRestores.push(() => (Transaction.prototype.commit = originalCommit));
		let txn;
		const context = {};
		const done = transaction(context, async () => {
			await DeadlineA.get('arm', context);
			await DeadlineA.put({ id: 'arm', name: 'armed' }, context);
			txn = context.transaction;
		});
		await waitFor(() => typeof txn?.commitStartedAt === 'number', {
			message: 'production must stamp the chain root at its first native commit submission',
		});
		releaseCommit();
		await done;
		assert.equal(txn.commitStartedAt, undefined, 'the clock must be released once the commit settles');
		assert.equal((await DeadlineA.get('arm'))?.name, 'armed');
	});

	it('abandons a coordinated-retry commit with a retryable 503 once the budget is spent', async function () {
		this.timeout(15000);
		const { attempts } = conflictCommits(DeadlineA, 'retryNow');
		const { outcome, error } = await outcomeOf(writePastBudget('retry-now', singleStoreWrite));
		assert.equal(outcome, 'rejected', 'the awaited transaction promise must reject, not hang or commit');
		assert.equal(error.statusCode, 503);
		assert.equal(error.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT');
		assert.equal(error.retryable, true, 'nothing of a single-store transaction landed, so a retry is safe');
		assert.match(error.message, /exceeding the \d+ms limit/);
		assert.equal(attempts.length, 1, 'an already-spent budget must abandon at the first retry decision');
	});

	it('abandons an ERR_BUSY conflict retry on the same budget', async function () {
		this.timeout(15000);
		const { attempts } = conflictCommits(DeadlineA, 'reject', { code: 'ERR_BUSY' });
		const { outcome, error } = await outcomeOf(writePastBudget('busy', singleStoreWrite));
		assert.equal(outcome, 'rejected');
		assert.equal(error.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT');
		assert.equal(error.retryable, true);
		// the uncoordinated path must not spend its quadratic backoff first — the budget is already gone
		assert.equal(attempts.length, 1, 'an already-spent budget must abandon before the backoff ladder');
	});

	// The chain root's clock, not a per-attempt one: the head's own commit succeeds and only the
	// SECOND store conflicts, so the budget the second store is measured against can only have come
	// from the head's submission.
	it('carries one budget across a multi-store chain and refuses to call a half-landed commit retryable', async function () {
		this.timeout(15000);
		const { attempts } = conflictCommits(DeadlineB, 'retryNow');
		let chained = false;
		const { outcome, error } = await outcomeOf(
			writePastBudget('chained', async (context, id) => {
				await DeadlineA.get(id, context);
				await DeadlineA.put({ id, name: 'chain-a' }, context);
				await DeadlineB.put({ id, name: 'chain-b' }, context);
				chained = !!context.transaction?.next;
			})
		);
		assert.ok(chained, 'the two databases should have produced a chained transaction');
		assert.equal(outcome, 'rejected');
		assert.equal(error.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT');
		assert.equal(
			error.retryable,
			false,
			'the first store already committed, so replaying the request would write it twice'
		);
		assert.equal(attempts.length, 1, 'the second store inherits the spent budget rather than starting a new one');
		assert.equal((await DeadlineA.get('chained'))?.name, 'chain-a', 'the head really did land durably');
	});

	// The other half of "nothing landed durably": a scope that already committed a segment mid-handler
	// has rotated onto a new generation, so replaying the request would write that segment twice.
	it('refuses to call a commit retryable once an earlier mid-scope segment landed', async function () {
		this.timeout(15000);
		const context = {};
		let rotated = false;
		const { outcome, error } = await outcomeOf(
			transaction(context, async () => {
				await DeadlineA.get('mid-scope', context);
				await DeadlineA.put({ id: 'mid-scope', name: 'segment-one' }, context);
				await context.transaction.commit();
				rotated = context.transaction.snapshotFree;
				await DeadlineA.put({ id: 'mid-scope-2', name: 'segment-two' }, context);
				conflictCommits(DeadlineA, 'retryNow');
				context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
			})
		);
		assert.ok(rotated, 'the mid-handler commit should have rotated the scope onto a new generation');
		assert.equal(outcome, 'rejected');
		assert.equal(error.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT');
		assert.equal(error.retryable, false, 'the first segment already landed, so a replay would repeat it');
		assert.equal((await DeadlineA.get('mid-scope'))?.name, 'segment-one', 'the first segment really did land');
	});

	// Source-applied writes have no resubscribe/sequence-resume path, so dropping one permanently
	// diverges the node: they are exempt from the deadline exactly as they are from the attempt cap.
	it('never abandons a source-applied commit, however long it has been conflicting', async function () {
		this.timeout(20000);
		const { attempts } = conflictCommits(DeadlineA, 'retryNow', { failFirst: 5 });
		const context = { sourceApply: true };
		const result = await outcomeOf(
			transaction(context, async () => {
				await DeadlineA.get('source', context);
				await DeadlineA.put({ id: 'source', name: 'source-apply' }, context);
				context.transaction.commitStartedAt = performance.now() - WELL_PAST_BUDGET_MS;
			})
		);
		assert.equal(result.outcome, 'committed', 'a source-applied write must retry past the budget, not be dropped');
		assert.equal(attempts.length, 5, 'every forced conflict was retried');
		assert.equal((await DeadlineA.get('source'))?.name, 'source-apply');
	});

	// A clock left set on the chain root would make the NEXT logical commit abandon on its first
	// conflict, converting a one-request failure into a permanently poisoned transaction path.
	it('releases the budget clock when the abandoned commit settles', async function () {
		this.timeout(20000);
		const { restore } = conflictCommits(DeadlineA, 'retryNow');
		const { outcome, error } = await outcomeOf(writePastBudget('reset', singleStoreWrite));
		assert.equal(outcome, 'rejected');
		assert.equal(error.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT', 'must abandon on the budget, not the attempt cap');
		restore();
		// A fresh transaction against the same table must commit normally, and one forced conflict
		// must still be retried rather than abandoned on a stale clock.
		const { attempts } = conflictCommits(DeadlineA, 'retryNow', { failFirst: 1 });
		const context = {};
		await transaction(context, async () => {
			await DeadlineA.get('reset', context);
			await DeadlineA.put({ id: 'reset', name: 'after-abandon' }, context);
		});
		assert.equal(attempts.length, 1, 'the retry after the forced conflict must have been allowed');
		assert.equal((await DeadlineA.get('reset'))?.name, 'after-abandon');
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined }, 'no commit left tracked');
	});
});
