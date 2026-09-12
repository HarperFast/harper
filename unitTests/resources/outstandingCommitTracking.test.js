require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getOutstandingCommits, trackOutstandingCommit } = require('#src/resources/DatabaseTransaction');
const { waitFor } = require('../waitFor');
// Outstanding-commit tracking lives on the base DatabaseTransaction (RocksDB path). LMDB writes route
// through the separate LMDBTransaction overrides (resources/LMDBTransaction.ts), which keep their own
// unrelated sentinel and do not feed this tracking — matching the carve-outs in transactionQueueDepth.test.js.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// getOutstandingCommits() is thread-global, and this thread is never idle: recording any commit's
// latency arms the analytics reporter, whose main-thread aggregation tick (startScheduledTasks in
// resources/analytics/write.ts) issues one unawaited hdb_analytics put per metric and per table —
// 100+ tracked commits in one burst, settling within tens of milliseconds. So an absolute count is
// only exact inside a synchronous window. The two helpers keep every assertion exact while tolerating
// such transient foreign work (not arbitrary foreign work: a bystander still pending past the settle
// deadline fails the assertion too, and then the reported age says so):
//  - trackedAcross(): the count delta across a synchronous callback. No foreign node can be linked or
//    unlinked between two reads with no await between them, so the delta is this test's alone.
//  - settleOutstandingCommits(): waits for the thread to drain to the expected count. A foreign burst
//    settles in milliseconds; a node left linked never does, so a regression still fails — after the
//    deadline, reporting the stuck count and its age.
const SETTLE_TIMEOUT_MS = 5000;
async function settleOutstandingCommits(expectedCount, message, timeout = SETTLE_TIMEOUT_MS) {
	let outstanding;
	try {
		await waitFor(() => (outstanding = getOutstandingCommits()).count === expectedCount, { timeout, interval: 5 });
	} catch {
		assert.fail(`${message}: still ${JSON.stringify(outstanding)} after ${timeout}ms`);
	}
	return outstanding;
}
async function assertAllUntracked(message) {
	const outstanding = await settleOutstandingCommits(0, message);
	assert.deepEqual(outstanding, { count: 0, oldestAgeMs: undefined });
}
function trackedAcross(submit) {
	const before = getOutstandingCommits().count;
	const result = submit();
	const outstanding = getOutstandingCommits();
	return { result, delta: outstanding.count - before, outstanding };
}

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
		// put() returns before the native commit settles, so the commit is outstanding right now.
		const { result: write, delta, outstanding } = trackedAcross(() => TrackA.put(1, { name: 'in-flight' }));
		await write;
		assert.equal(delta, 1, 'an in-flight commit should be tracked');
		assert.equal(typeof outstanding.oldestAgeMs, 'number', 'a tracked commit should report an age');
		assert.ok(outstanding.oldestAgeMs >= 0, 'a tracked commit should report a non-negative age');
	});

	// The defect this guards: tracking used to occupy a single shared slot, claimed by whichever
	// commit happened to find it free. Every other commit in flight at that moment was invisible to
	// checkOverloaded(), so if one of THOSE wedged, no 503 was ever raised and the write queue grew
	// unbounded. Concurrent commits must each be tracked, not sampled one at a time.
	it('tracks every concurrent commit, not just the first', async function () {
		if (isLMDB) return;
		const { result: writes, delta } = trackedAcross(() =>
			Array.from({ length: 8 }, (unused, index) => TrackA.put(100 + index, { name: `c${index}` }))
		);
		await Promise.all(writes);
		assert.equal(delta, writes.length, 'each concurrent commit should be tracked independently');
	});

	// A node left linked after its commit settled would make every write on this thread throw 503
	// once it aged past the threshold, and never recover. These assert the unlink is complete for
	// each write shape, including from the middle and both ends of the list.
	it('untracks a single-table commit once it settles', async function () {
		if (isLMDB) return;
		await TrackA.put(2, { name: 'single' });
		await assertAllUntracked('a settled single-table commit should be untracked');
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
		await assertAllUntracked('every link of a settled chained transaction should be untracked');
		assert.equal((await TrackA.get(3))?.name, 'chain-a');
		assert.equal((await TrackB.get(3))?.name, 'chain-b');
	});

	// The test above only proves the chain finishes clean at count 0 — that also passes if
	// `this.next.commit()`'s tracking were silently omitted, since the untouched slot was never
	// incremented in the first place. Hold the second (chained) link's native commit open through a
	// narrow test seam (patching Transaction.prototype.commit, scoped to TrackB's store, the same
	// idiom lingeringWriteCommit.test.js uses) so we can observe the count while ONLY that link is
	// outstanding: TrackA's own commit has already settled and untracked itself by the time
	// `this.next.commit()` even runs, so a nonzero count here can only come from the second link.
	it('tracks the second (chained) commit while it is pending, not just the first', async function () {
		if (isLMDB) return;
		this.timeout(15000);
		let chained = false;
		const context = {};
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = TrackB.primaryStore.store.db;
		let releaseHold;
		const held = new Promise((resolve) => (releaseHold = resolve));
		let signalSecondCommitStarted;
		// TrackA's own native commit is also tracked (briefly — it settles and untracks itself before
		// `this.next.commit()` even runs, since `untrack` is attached ahead of the resolve handler that
		// calls it). Without this signal, the poll loop below could observe THAT transient count>0 and
		// stop before TrackB's commit is even submitted, letting the assertions pass without ever
		// actually exercising the re-entrant path this test exists to cover. Only start asserting once
		// TrackB's (patched) commit has definitely been invoked.
		const secondCommitStarted = new Promise((resolve) => (signalSecondCommitStarted = resolve));
		Transaction.prototype.commit = function (...args) {
			if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
			const realCommit = originalCommit.apply(this, args);
			signalSecondCommitStarted();
			return held.then(() => realCommit);
		};
		let done;
		try {
			done = transaction(context, async () => {
				// A real write on TrackA (not just a read) gives the head link its own native commit, so
				// TrackB's commit is issued from INSIDE that commit's resolve handler — the re-entrant path
				// this test exists to cover. A read-only head aborts synchronously with no commitResolution,
				// so TrackB's commit would start through the ordinary top-level path instead, and this test
				// would pass even against the old single-slot implementation.
				await TrackA.put(4, { name: 'chain-a-2' }, context);
				await TrackB.put(4, { name: 'chain-b-2' }, context);
				chained = !!context.transaction?.next;
			});
			// Race against a bounded timeout, not a bare await: if a regression means TrackB's commit is
			// never invoked, `secondCommitStarted` would otherwise never settle. Mocha's own test timeout
			// doesn't cancel this still-running async function, so an unbounded await here would hang
			// forever with `Transaction.prototype.commit` left monkeypatched, breaking every later test
			// that touches RocksDB. This timeout is comfortably inside the 15s test timeout, so `finally`
			// below still gets to run and restore everything before mocha's own timeout would fire.
			let timeoutHandle;
			try {
				await Promise.race([
					secondCommitStarted,
					new Promise(
						(_resolve, reject) =>
							(timeoutHandle = setTimeout(
								() => reject(new Error("TrackB's commit was never invoked (tracking regression?)")),
								10000
							))
					),
				]);
			} finally {
				// Otherwise the successful path leaves this timer referenced, keeping a targeted run of
				// this file alone alive for ~10s after the result is already known.
				clearTimeout(timeoutHandle);
			}
			assert.ok(chained, 'the two databases should have produced a chained transaction');
			// TrackA's node is unlinked before `this.next.commit()` runs (see the comment above), so once
			// any foreign commits drain, count===1 can only be TrackB's held commit.
			const outstanding = await settleOutstandingCommits(
				1,
				'the chained second-database commit should be tracked while pending'
			);
			assert.equal(typeof outstanding.oldestAgeMs, 'number', 'the pending chained commit should report an age');
		} finally {
			// Always restore the prototype and release the held commit, even if an assertion above threw —
			// otherwise `done`'s chained commit stays pending forever and poisons every later test's count.
			Transaction.prototype.commit = originalCommit;
			releaseHold();
			if (done) await done.catch(() => {});
		}
		await assertAllUntracked('the released chained commit should be untracked');
		assert.equal((await TrackA.get(4))?.name, 'chain-a-2');
		assert.equal((await TrackB.get(4))?.name, 'chain-b-2');
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
		const { delta } = trackedAcross(() => {
			for (const { promise } of deferred) trackOutstandingCommit(promise);
		});
		assert.equal(delta, 5);
		for (const index of [2, 0, 4, 1, 3]) {
			// middle, head, tail, then the remainder
			deferred[index].settle();
			await deferred[index].promise;
		}
		await assertAllUntracked('every out-of-order settled node should be untracked');
	});

	it('untracks a commit that rejects', async function () {
		if (isLMDB) return;
		const rejected = Promise.reject(new Error('ERR_BUSY'));
		trackOutstandingCommit(rejected);
		await rejected.catch(() => {});
		await assertAllUntracked('a rejected commit should be untracked');
	});

	it('tracks an already-settled promise and still untracks it', async function () {
		if (isLMDB) return;
		const settled = Promise.resolve();
		// The node is linked synchronously; the untrack reaction is queued behind it.
		const { delta } = trackedAcross(() => trackOutstandingCommit(settled));
		assert.equal(delta, 1);
		await assertAllUntracked('an already-settled tracked promise should still be untracked');
	});

	it('treats the same promise tracked twice as two independent attempts', async function () {
		if (isLMDB) return;
		let settle;
		const shared = new Promise((resolve) => (settle = resolve));
		const { delta } = trackedAcross(() => {
			trackOutstandingCommit(shared);
			trackOutstandingCommit(shared);
		});
		assert.equal(delta, 2);
		settle();
		await shared;
		await assertAllUntracked('both attempts on a shared promise should be untracked');
	});

	// The CI flake this file used to have: the analytics aggregation tick landed inside the chained
	// test's ~40ms window and the bare thread-global read returned 130–145 in-flight foreign commits
	// with a young oldestAgeMs. Reproduce that state deterministically — foreign nodes tracked for
	// the whole duration of this test's own chained write and released only afterwards — and show
	// the assertions above stay exact under it rather than counting the bystanders.
	it('keeps its assertions exact while foreign commits are in flight on the thread', async function () {
		if (isLMDB) return;
		let releaseForeign;
		const foreign = new Promise((resolve) => (releaseForeign = resolve));
		const FOREIGN_COMMITS = 140;
		try {
			const { delta } = trackedAcross(() => {
				for (let index = 0; index < FOREIGN_COMMITS; index++) trackOutstandingCommit(foreign);
			});
			assert.equal(delta, FOREIGN_COMMITS);
			const context = {};
			let chained = false;
			await TrackA.put(5, { name: 'chain-a-3' });
			await transaction(context, async () => {
				await TrackA.get(5, context);
				await TrackB.put(5, { name: 'chain-b-3' }, context);
				chained = !!context.transaction?.next;
			});
			assert.ok(chained, 'the two databases should have produced a chained transaction');
			// What the old assertion read at this point: the bystanders, not this test's own (already
			// untracked) links. The chained links are proven untracked only once the foreign burst
			// settles, below.
			assert.ok(getOutstandingCommits().count >= FOREIGN_COMMITS, 'the foreign commits are still in flight');
			const { result: underLoad, delta: ownDelta } = trackedAcross(() => TrackA.put(6, { name: 'under-load' }));
			assert.equal(ownDelta, 1, 'a synchronous-window delta ignores the in-flight bystanders');
			await underLoad;
		} finally {
			// Never leave the foreign nodes linked: they would age past the overload threshold and 503
			// every later write on this thread.
			releaseForeign();
		}
		await assertAllUntracked('own links and the released foreign commits should all be untracked');
		assert.equal((await TrackA.get(5))?.name, 'chain-a-3');
		assert.equal((await TrackB.get(5))?.name, 'chain-b-3');
	});

	// Proves the settle helper is still a leak detector: waiting for the count is what lets it tolerate
	// bystanders, so it must not also wait its way past a node that never unlinks.
	it('the settle assertion rejects a node that never unlinks, reporting its count and age', async function () {
		if (isLMDB) return;
		let releaseStuck;
		const stuck = new Promise((resolve) => (releaseStuck = resolve));
		try {
			trackOutstandingCommit(stuck);
			await assert.rejects(settleOutstandingCommits(0, 'stuck node', 200), (error) =>
				/stuck node: still \{"count":[1-9]\d*,"oldestAgeMs":\d{3,}/.test(error.message)
			);
		} finally {
			releaseStuck();
		}
		await assertAllUntracked('the released stuck node should be untracked');
	});
});
