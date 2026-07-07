require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { setTimeout: delay } = require('node:timers/promises');

// A source-apply commit that fails its optimistic-conflict check must converge on retry. ERR_BUSY
// always could: recommitting re-writes each key, re-tracking it at the current sequence, so
// validation passes once the contention clears. ERR_TRY_AGAIN never could: the memtable history
// validation needs is gone (flushed during a bulk-ingest burst), and recommitting the same
// transaction re-checks the same stranded snapshot, so it fails forever even on an idle database.
// The uncapped source-apply retry then spins for good and wedges the replication apply loop at its
// commit await, freezing every replication leg of that database on the node. ERR_TRY_AGAIN retries
// must replay the writes onto a fresh transaction so validation runs against current state.
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
		});
	});

	// Spy on commits so the test can see which attempt failed validation and whether the retry ran
	// on a fresh transaction (a new transaction id) or recommitted the failed one.
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

	it('commits after a conflicting write lands mid-transaction (ERR_BUSY)', async function () {
		this.timeout(15000);
		const { attempts, restore } = spyOnCommits();
		try {
			await SpinTable.put('busy', { id: 'busy', writer: 'original' });
			const outcome = await applyWithMidTransactionConflict('busy', { writer: 'apply' }, { writer: 'concurrent' });
			assert.equal(outcome, 'committed', 'the conflicted source-apply commit must settle');
			const failed = attempts.find((attempt) => attempt.code === 'ERR_BUSY' || attempt.code === 'ERR_TRY_AGAIN');
			assert.ok(failed, 'the mid-transaction write should have failed the first commit validation');
			assert.ok(
				attempts.find((attempt, index) => attempt.ok && index > attempts.indexOf(failed)),
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
			const failed = attempts.find((attempt) => attempt.code === 'ERR_TRY_AGAIN');
			assert.ok(failed, 'the flush should strand the snapshot outside the memtable window');
			const retried = attempts.find((attempt, index) => attempt.ok && index > attempts.indexOf(failed));
			assert.ok(retried, 'a later commit attempt must succeed');
			assert.notEqual(retried.id, failed.id, 'the retry must run on a fresh transaction');
		} finally {
			restore();
		}
	});

	it('preserves concurrent commutative increments across a stranded-snapshot retry', async function () {
		this.timeout(15000);
		await SpinTable.put('counter', { id: 'counter', count: 0 });
		const outcome = await applyWithMidTransactionConflict(
			'counter',
			{ count: { __op__: 'add', value: 1 } },
			{ count: { __op__: 'add', value: 1 } },
			() => SpinTable.primaryStore.store.compact()
		);
		assert.equal(outcome, 'committed', 'the stranded source-apply commit must settle');
		const record = await SpinTable.get('counter');
		assert.equal(record.count, 2, 'both increments must survive the fresh-transaction replay');
	});
});
