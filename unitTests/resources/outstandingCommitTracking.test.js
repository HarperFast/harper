require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getOutstandingCommits, trackOutstandingCommit } = require('#src/resources/DatabaseTransaction');
// Outstanding-commit tracking lives on the base DatabaseTransaction (RocksDB path). LMDB writes route
// through the separate LMDBTransaction overrides (resources/LMDBTransaction.ts), which keep their own
// unrelated sentinel and do not feed this tracking — matching the carve-outs in transactionQueueDepth.test.js.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Outstanding commit tracking', () => {
	let TrackA, TrackB;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		TrackA = table({
			table: 'OutstandingCommitA',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		// A DIFFERENT database, deliberately: txnForContext() reuses one transaction for every table
		// sharing a database path and only builds the `transaction.next` chain across databases
		// (Table.ts), so two tables in one database would not exercise the chained-commit path at all.
		TrackB = table({
			table: 'OutstandingCommitB',
			database: 'testChained',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	it('tracks a commit while it is in flight', async function () {
		if (isLMDB) return;
		const write = TrackA.put(1, { name: 'in-flight' });
		// put() returns before the native commit settles, so the commit is outstanding right now.
		const outstanding = getOutstandingCommits();
		await write;
		assert.equal(outstanding.count, 1, 'an in-flight commit should be tracked');
		assert.equal(typeof outstanding.oldestAgeMs, 'number', 'a tracked commit should report an age');
		assert.ok(outstanding.oldestAgeMs >= 0, 'a tracked commit should report a non-negative age');
	});

	// The defect this guards: tracking used to occupy a single shared slot, claimed by whichever
	// commit happened to find it free. Every other commit in flight at that moment was invisible to
	// checkOverloaded(), so if one of THOSE wedged, no 503 was ever raised and the write queue grew
	// unbounded. Concurrent commits must each be tracked, not sampled one at a time.
	it('tracks every concurrent commit, not just the first', async function () {
		if (isLMDB) return;
		const writes = Array.from({ length: 8 }, (unused, index) => TrackA.put(100 + index, { name: `c${index}` }));
		const outstanding = getOutstandingCommits();
		await Promise.all(writes);
		assert.equal(outstanding.count, writes.length, 'each concurrent commit should be tracked independently');
	});

	// A node left linked after its commit settled would make every write on this thread throw 503
	// once it aged past the threshold, and never recover. These assert the unlink is complete for
	// each write shape, including from the middle and both ends of the list.
	it('untracks a single-table commit once it settles', async function () {
		if (isLMDB) return;
		await TrackA.put(2, { name: 'single' });
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined });
	});

	it('untracks every link of a cross-database (chained) transaction', async function () {
		if (isLMDB) return;
		// The second database's commit is issued from inside the first commit's resolve handler —
		// the re-entrant path that the previous single-slot tracking always skipped.
		await TrackA.put(3, { name: 'chain-a' });
		let chained = false;
		const context = {};
		// The chain only forms across DATABASES, and only when a read initializes the head first: a
		// leading put() claims the uninitialized transaction for its own store, after which every
		// later write resolves onto that same link.
		await transaction(context, async () => {
			await TrackA.get(3, context);
			await TrackB.put(3, { name: 'chain-b' }, context);
			// Assert the fixture really built a chain, so this test cannot silently stop covering
			// the chained-commit path.
			chained = !!context.transaction?.next;
		});
		assert.ok(chained, 'the two databases should have produced a chained transaction');
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined });
		assert.equal((await TrackA.get(3))?.name, 'chain-a');
		assert.equal((await TrackB.get(3))?.name, 'chain-b');
	});

	it('untracks commits that settle out of order, from the head, middle and tail', async function () {
		if (isLMDB) return;
		// Drive the list directly with deferred promises so the settle ORDER is controlled rather
		// than merely concurrent: a rewiring bug that only shows when a middle or tail node leaves
		// first is invisible to writes that happen to settle in submission order.
		const deferred = Array.from({ length: 5 }, () => {
			let settle;
			const promise = new Promise((resolve) => (settle = resolve));
			return { promise, settle };
		});
		for (const { promise } of deferred) trackOutstandingCommit(promise);
		assert.equal(getOutstandingCommits().count, 5);
		for (const index of [2, 0, 4, 1, 3]) {
			// middle, head, tail, then the remainder
			deferred[index].settle();
			await deferred[index].promise;
		}
		await new Promise((resolve) => setImmediate(resolve)); // let the last untrack reaction run
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined });
	});

	it('untracks a commit that rejects', async function () {
		if (isLMDB) return;
		const rejected = Promise.reject(new Error('ERR_BUSY'));
		trackOutstandingCommit(rejected);
		await rejected.catch(() => {});
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined });
	});

	it('tracks an already-settled promise and still untracks it', async function () {
		if (isLMDB) return;
		const settled = Promise.resolve();
		trackOutstandingCommit(settled);
		// The node is linked synchronously; the untrack reaction is queued behind it.
		assert.equal(getOutstandingCommits().count, 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined });
	});

	it('treats the same promise tracked twice as two independent attempts', async function () {
		if (isLMDB) return;
		let settle;
		const shared = new Promise((resolve) => (settle = resolve));
		trackOutstandingCommit(shared);
		trackOutstandingCommit(shared);
		assert.equal(getOutstandingCommits().count, 2);
		settle();
		await shared;
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(getOutstandingCommits(), { count: 0, oldestAgeMs: undefined });
	});
});
