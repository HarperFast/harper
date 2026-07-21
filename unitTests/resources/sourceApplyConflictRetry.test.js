require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseTransaction, TRANSACTION_STATE, setTxnExpiration } = require('#src/resources/DatabaseTransaction');
// A coordinatedRetry transaction (the source-apply path) signals an optimistic write conflict by
// resolving commit() with this sentinel instead of rejecting with ERR_BUSY.
const RETRY_NOW_VALUE = require('@harperfast/rocksdb-js').constants.RETRY_NOW_VALUE;

// A source-apply commit that fails its optimistic-conflict check must converge on retry. ERR_BUSY
// always could: recommitting re-writes each key, re-tracking it at the current sequence, so
// validation passes once the contention clears. ERR_TRY_AGAIN could not: the memtable history
// validation needs is gone (flushed during a bulk-ingest burst), and recommitting the same
// transaction re-checked the same stranded snapshot, so it failed forever even on an idle database.
// The uncapped source-apply retry then spun for good and wedged the replication apply loop at its
// commit await, freezing every replication leg of that database on the node. rocksdb-js now resets
// the transaction onto a fresh snapshot on a failed TryAgain commit (as it always did for IsBusy),
// so the retry recommits the SAME transaction and its re-run validates against current state.
describe('source-apply conflict retry converges instead of spinning', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let SpinTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		SpinTable = table({
			table: 'ConflictRetryTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'writer' }, { name: 'count' }],
			audit: true,
		});
	});

	// Spy on commits so the test can see which attempt failed validation and confirm the retry
	// recommitted the same transaction (same id) after the native in-place snapshot reset.
	function spyOnCommits() {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const attempts = [];
		Transaction.prototype.commit = function (...args) {
			const attempt = { id: this.id };
			attempts.push(attempt);
			return originalCommit.apply(this, args).then(
				(result) => {
					attempt.ok = true;
					// coordinatedRetry commits resolve with RETRY_NOW_VALUE on conflict rather than rejecting;
					// record the resolution so a conflict on the coordinated path is observable.
					attempt.result = result;
					return result;
				},
				(error) => {
					attempt.code = error.code;
					throw error;
				}
			);
		};
		return { attempts, restore: () => (Transaction.prototype.commit = originalCommit) };
	}

	async function applyWithMidTransactionConflict(id, record, concurrentRecord, disturb) {
		const context = { sourceApply: true };
		const txnDone = transaction(context, async () => {
			await SpinTable.patch(id, record, context);
			// an independent transaction on the same key, committed while this one is still open,
			// so this transaction's commit fails optimistic validation
			const concurrentContext = {};
			await transaction(concurrentContext, async () => {
				await SpinTable.patch(id, concurrentRecord, concurrentContext);
			});
			await disturb?.();
		});
		return Promise.race([
			Promise.resolve(txnDone).then(
				() => 'committed',
				(error) => 'rejected: ' + error.message
			),
			delay(4000).then(() => 'spinning'),
		]);
	}

	// The field failure was a locally-correct record with a missing change-feed entry, and the fix
	// relies on the first attempt's audit entry surviving the aborted transaction. Pin that by
	// counting the record's queryable patch entries (poll: the keyed transaction-log read can lag a
	// recent write, #1137).
	async function patchEntryCount(id, atLeast) {
		for (let i = 0; i < 200; i++) {
			let count = 0;
			for (const entry of SpinTable.auditStore.getRange({ start: 1 })) {
				if (entry.recordId === id && entry.type === 'patch') count++;
			}
			if (count >= atLeast) return count;
			await delay(10);
		}
		return -1;
	}

	it('commits after a conflicting write lands mid-transaction (ERR_BUSY)', async function () {
		this.timeout(15000);
		const { attempts, restore } = spyOnCommits();
		try {
			await SpinTable.put('busy', { id: 'busy', writer: 'original' });
			const outcome = await applyWithMidTransactionConflict('busy', { writer: 'apply' }, { writer: 'concurrent' });
			assert.equal(outcome, 'committed', 'the conflicted source-apply commit must settle');
			// The conflict surfaces one of two ways depending on how the transaction was created: the
			// coordinatedRetry source-apply transaction resolves commit() with the RETRY_NOW_VALUE sentinel
			// (record-caching's coordinated path), while an uncoordinated transaction rejects with ERR_BUSY
			// (or ERR_TRY_AGAIN). Either is a detected conflict that must then have been retried.
			const failed = attempts.find(
				(attempt) =>
					attempt.result === RETRY_NOW_VALUE || attempt.code === 'ERR_BUSY' || attempt.code === 'ERR_TRY_AGAIN'
			);
			assert.ok(failed, 'the mid-transaction write should have failed the first commit validation');
			assert.ok(
				attempts.find(
					(attempt, index) => attempt.ok && attempt.result !== RETRY_NOW_VALUE && index > attempts.indexOf(failed)
				),
				'a later commit attempt must succeed'
			);
		} finally {
			restore();
		}
	});

	it('commits after a memtable flush strands the transaction snapshot (ERR_TRY_AGAIN)', async function () {
		this.timeout(15000);
		const { attempts, restore } = spyOnCommits();
		try {
			await SpinTable.put('stranded', { id: 'stranded', writer: 'original' });
			// compacting flushes the memtables, discarding the sequence history conflict validation
			// needs, so the commit fails with ERR_TRY_AGAIN instead of ERR_BUSY
			const outcome = await applyWithMidTransactionConflict(
				'stranded',
				{ writer: 'apply' },
				{ writer: 'concurrent' },
				() => SpinTable.primaryStore.store.compact()
			);
			assert.equal(outcome, 'committed', 'the stranded source-apply commit must settle');
			// no change-feed assertion here: this write is fully superseded by the newer concurrent
			// patch, and a superseded plain write takes the early-out with no dedicated audit entry by
			// design (nothing to publish, and a redelivery re-folds to the same no-op). The entry
			// invariant matters for commutative ops and is pinned in the increments test below.
			const failed = attempts.find((attempt) => attempt.code === 'ERR_TRY_AGAIN');
			assert.ok(failed, 'the flush should strand the snapshot outside the memtable window');
			const retried = attempts.find((attempt, index) => attempt.ok && index > attempts.indexOf(failed));
			assert.ok(retried, 'a later commit attempt must succeed');
			assert.equal(
				retried.id,
				failed.id,
				'the retry must recommit the same transaction, reset in place onto a fresh snapshot'
			);
		} finally {
			restore();
		}
	});

	it('preserves concurrent commutative increments across a stranded-snapshot retry', async function () {
		this.timeout(15000);
		const { attempts, restore } = spyOnCommits();
		try {
			await SpinTable.put('counter', { id: 'counter', count: 0 });
			const outcome = await applyWithMidTransactionConflict(
				'counter',
				{ count: { __op__: 'add', value: 1 } },
				{ count: { __op__: 'add', value: 1 } },
				() => SpinTable.primaryStore.store.compact()
			);
			assert.equal(outcome, 'committed', 'the stranded source-apply commit must settle');
			assert.equal(
				await patchEntryCount('counter', 2),
				2,
				'both increments must keep queryable change-feed entries (redelivery dedup depends on them)'
			);
			assert.ok(
				attempts.some((attempt) => attempt.code === 'ERR_TRY_AGAIN'),
				'premise: the flush must strand the snapshot (ERR_TRY_AGAIN), not just conflict (ERR_BUSY)'
			);
			const record = await SpinTable.get('counter');
			assert.equal(record.count, 2, 'both increments must survive the fresh-transaction replay');
		} finally {
			restore();
		}
	});

	it('still dedupes a genuine re-delivered duplicate co-batched with the conflicting write', async function () {
		this.timeout(30000);
		// The own-orphaned-entry suppression must be per-write, not transaction-wide: a genuine
		// duplicate (its exact version and node already in the audit log from a committed
		// transaction) that shares the batch with the write that caused the retry must still be
		// deduped on the retry, or it double-applies its commutative op.
		// natural versions throughout: an explicit past timestamp would predate every log entry's
		// localTime and trip the #480 pre-retention guard, which disarms the keyed dedup this test is
		// exercising (documented best-effort gap for out-of-timestamp-order logs)
		await SpinTable.put('mixed-fresh', { id: 'mixed-fresh', count: 0 });
		await SpinTable.patch('mixed-dup', { count: { __op__: 'add', value: 1 } });
		// re-deliver at the exact committed version so the keyed dedup applies
		const version = SpinTable.primaryStore.getEntry('mixed-dup').version;
		// the keyed transaction-log lookup can lag a just-committed write (#1137); wait until the
		// prior write's audit entry is readable so the duplicate is deduped by state, not by luck
		let auditEntryVisible = false;
		for (let i = 0; i < 200 && !auditEntryVisible; i++) {
			const entry = SpinTable.auditStore.get(version, SpinTable.tableId, 'mixed-dup', undefined);
			if (entry && entry.version === version) auditEntryVisible = true;
			else await delay(10);
		}
		assert.ok(auditEntryVisible, 'premise: the committed duplicate audit entry must be readable');
		// Bury the duplicate's entry past the out-of-order walk's depth cap so the walk cannot rescue
		// it through its own identity-tie check; the skip must come from the guarded keyed dedup /
		// isReDeliveredDuplicate paths, which is what makes this test discriminate a per-write guard
		// from a transaction-wide one (the walk tie made the shallow variant pass under either).
		for (let i = 0; i <= 1000; i++) {
			await SpinTable.patch('mixed-dup', { writer: 'newer' + i });
		}
		assert.equal((await SpinTable.get('mixed-dup')).count, 1, 'premise: count intact after burying');
		const { attempts, restore } = spyOnCommits();
		try {
			const context = { sourceApply: true, timestamp: version };
			const txnDone = transaction(context, async () => {
				await SpinTable.patch('mixed-fresh', { count: { __op__: 'add', value: 1 } }, context);
				// exact re-delivery of the already-committed write: same key, same version, same node
				await SpinTable.patch('mixed-dup', { count: { __op__: 'add', value: 1 } }, context);
				const concurrentContext = {};
				await transaction(concurrentContext, async () => {
					await SpinTable.patch('mixed-fresh', { count: { __op__: 'add', value: 1 } }, concurrentContext);
				});
				await SpinTable.primaryStore.store.compact();
			});
			const outcome = await Promise.race([
				Promise.resolve(txnDone).then(
					() => 'committed',
					(error) => 'rejected: ' + error.message
				),
				delay(6000).then(() => 'spinning'),
			]);
			assert.equal(outcome, 'committed', 'the batched source-apply commit must settle');
			assert.ok(
				attempts.some((attempt) => attempt.code === 'ERR_TRY_AGAIN'),
				'premise: the flush must strand the snapshot (ERR_TRY_AGAIN), not just conflict (ERR_BUSY)'
			);
			assert.equal((await SpinTable.get('mixed-dup')).count, 1, 'the co-batched duplicate must not double-apply');
			assert.equal((await SpinTable.get('mixed-fresh')).count, 2, 'both fresh increments must survive');
		} finally {
			restore();
		}
	});
});

// abortChainAfterRetries() gives up on a linked chain of transactions (multi-store commit) after
// exhausting conflict retries. Its two-pass design (poison every link, then abort/release each) exists
// specifically so a throw from one link's cleanup can't strand later links holding native handles /
// read snapshots until GC. Exercised directly against the class rather than through 40 real retries,
// which would require forcing MAX_RETRIES real conflicts end-to-end.
describe('abortChainAfterRetries chain cleanup', () => {
	// A minimal stand-in for a native RocksTransaction: abort() is the only method the wrapper calls.
	function fakeNative() {
		return {
			aborted: false,
			abort() {
				this.aborted = true;
			},
		};
	}

	it("still detaches, untracks, and natively aborts later links when an earlier link's wrapper cleanup throws", () => {
		const head = new DatabaseTransaction();
		const next = new DatabaseTransaction();
		head.next = next;

		const headNative = fakeNative();
		const nextNative = fakeNative();
		next.transaction = nextNative;

		// The head's write throws from wrapper cleanup (abort() synchronously calls
		// write.store.getEntry(), which can fail on a closed store or decode error).
		head.writes = [
			{
				savedBlobs: true,
				key: 'poison',
				store: {
					getEntry() {
						throw new Error('store closed');
					},
				},
			},
		];
		next.writes = [];

		const trackedTxns = setTxnExpiration(30000); // grabs the module's live tracking Set, no behavior change
		trackedTxns.add(head);
		trackedTxns.add(next);

		// Must not throw: a link's cleanup failure is caught and logged, not propagated (or it would
		// pre-empt the caller's give-up ServerError at the call site).
		assert.doesNotThrow(() => head.abortChainAfterRetries(headNative));

		assert.equal(head.open, TRANSACTION_STATE.CLOSED, 'head must be poisoned even though its cleanup threw');
		assert.equal(next.open, TRANSACTION_STATE.CLOSED, 'later link must be poisoned');

		assert.ok(headNative.aborted, 'head native transaction must still be aborted');
		assert.ok(
			nextNative.aborted,
			"later link's native transaction must be aborted despite the earlier link's cleanup exception"
		);

		assert.equal(next.transaction, null, 'later link must have its native handle detached');
		assert.ok(!trackedTxns.has(head), 'head must be untracked');
		assert.ok(!trackedTxns.has(next), "later link must be untracked despite the earlier link's cleanup exception");
	});
});
