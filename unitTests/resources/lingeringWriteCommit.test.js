require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { setTimeout: delay } = require('node:timers/promises');

// A commit issued while a search iterator still holds the read transaction cannot commit the
// native handle (the iterator's native cursor lives inside it), but it must not defer the writes
// either: the old LINGERING deferral committed them from doneReadTxn() when the last iterator
// finished, so anything that kept that from happening cleanly — a hung stream, the
// long-transaction monitor's timeout abort — silently dropped writes the caller had already been
// told were committed. commit() now replays the staged writes onto a fresh transaction and
// commits them immediately (ERR_TRY_AGAIN-replay style); the original handle stays open only for
// the iterators and is aborted, empty of responsibilities, when they finish.
describe('commit with open read iterators commits writes immediately on a replay transaction', () => {
	// RocksDB-only: LMDB never defers a commit on open read transactions (its reads don't block
	// writes), so the iterator-retained-handle scenario this pins doesn't exist there.
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let LingerTable;
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		LingerTable = table({
			table: 'LingeringWriteTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
			audit: true,
		});
		await LingerTable.put({ id: 'seed1', v: 1 });
		await LingerTable.put({ id: 'seed2', v: 2 });
		process.on('unhandledRejection', onUnhandled);
	});

	after(() => {
		process.removeListener('unhandledRejection', onUnhandled);
	});

	// Start a search and pull a single result so the iterator keeps the read transaction in use
	// (useReadTxn) across the transaction()'s commit.
	async function commitWithOpenIterator(writeId, disturb) {
		let iterator;
		const context = {};
		await transaction(context, async () => {
			const results = await LingerTable.search({ conditions: [] }, context);
			iterator = results[Symbol.asyncIterator]();
			await iterator.next();
			await LingerTable.put({ id: writeId, v: 42 }, context);
			await disturb?.(context);
		});
		return { context, iterator };
	}

	it('the write is durable when commit resolves, while the iterator is still open', async function () {
		this.timeout(15000);
		const { context, iterator } = await commitWithOpenIterator('linger-write');
		assert.equal(
			context.transaction.open,
			TRANSACTION_STATE.CLOSED,
			'the commit must close the transaction — no LINGERING deferral'
		);
		assert.ok(context.transaction.transaction, 'premise: the open iterator must retain the native read handle');
		// the awaited commit chain includes the replay commit, so the write is already readable —
		// before the iterator finishes
		const record = await LingerTable.get('linger-write');
		assert.ok(record, 'the write staged behind an open iterator must be committed by the time commit resolves');
		assert.equal(record.v, 42);
		while (!(await iterator.next()).done);
		await delay(50); // give a released-handle failure a beat to surface as an unhandledRejection
		assert.equal(context.transaction.transaction, null, 'the drained iterator must release the native handle');
		assert.ok(await LingerTable.get('linger-write'), 'releasing the read handle must not disturb the committed write');
		assert.deepEqual(unhandled, [], 'the replay commit must not leak an unhandled rejection');
	});

	it('a write after the transaction closed commits independently; the earlier write is already durable', async function () {
		this.timeout(15000);
		// The transactional wrapper only reuses a context transaction that is OPEN (Resource.ts), so a
		// put against the same context after the commit runs on a fresh transaction. (Internal paths
		// that reach the retained transaction via txnForContext take save()'s immediate-commit branch —
		// a closed transaction never accepts new staged writes.)
		const { context, iterator } = await commitWithOpenIterator('linger-early');
		const closedTxn = context.transaction;
		assert.equal(closedTxn.open, TRANSACTION_STATE.CLOSED);
		assert.ok(await LingerTable.get('linger-early'), 'the pre-close write must already be committed');
		await LingerTable.put({ id: 'linger-late', v: 2 }, context);
		assert.notEqual(context.transaction, closedTxn, 'premise: the late write ran on a fresh transaction');
		assert.ok(await LingerTable.get('linger-late'), 'the independent write must be committed immediately');
		while (!(await iterator.next()).done);
		assert.ok(await LingerTable.get('linger-early'), 'draining the iterator must not disturb the earlier write');
		await delay(50); // unhandledRejection lands on a later event-loop turn
		assert.deepEqual(unhandled, [], 'neither commit may leak an unhandled rejection');
	});

	it('a terminally failing replay commit rejects the awaited commit chain; the iterator survives', async function () {
		this.timeout(15000);
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = LingerTable.primaryStore.store.db;
		let forcedFailures = 0;
		let rejection;
		let iterator;
		const context = {};
		try {
			await transaction(context, async () => {
				const results = await LingerTable.search({ conditions: [] }, context);
				iterator = results[Symbol.asyncIterator]();
				await iterator.next();
				await LingerTable.put({ id: 'linger-fail', v: 42 }, context);
				// arm after the transaction is set up: fail the replay's native commit terminally
				Transaction.prototype.commit = function (...args) {
					if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
					forcedFailures++;
					return Promise.reject(Object.assign(new Error('forced terminal failure'), { code: 'ERR_CORRUPTION' }));
				};
			}).then(
				() => {},
				(error) => {
					rejection = error;
				}
			);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		assert.ok(forcedFailures > 0, 'premise: the replay commit must have run and failed');
		assert.ok(rejection, 'a terminal replay-commit failure must reject the awaited commit chain, not vanish');
		assert.equal(rejection.message, 'forced terminal failure');
		assert.equal(await LingerTable.get('linger-fail'), undefined, 'the failed write is not committed');
		// the original read handle must survive the replay failure: the iterator finishes normally
		while (!(await iterator.next()).done);
		assert.equal(context.transaction.transaction, null, 'the drained iterator must still release the native handle');
		await delay(100);
		assert.deepEqual(unhandled, [], 'a replay-commit failure must reject the awaited chain, never float unhandled');
	});
});
