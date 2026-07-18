require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { setTimeout: delay } = require('node:timers/promises');

// A commit issued while a search iterator still holds the read transaction goes LINGERING: the
// native commit is deferred until the last iterator finishes (doneReadTxn), because blocking the
// commit on iterator completion could deadlock a response that streams the iterator after the
// handler returns. The staged writes must survive that deferral — commit() used to clear
// this.writes on the LINGERING fall-through, so the deferred commit found an empty write set and
// aborted the native transaction, silently dropping every write the caller was told succeeded.
describe('lingering commit preserves writes staged while iterators are open', () => {
	// RocksDB-only: LMDB never defers a commit on open read transactions (its reads don't block
	// writes; a post-LINGERING write goes through an ImmediateTransaction), so the deferral this
	// pins doesn't exist there.
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
	// (useReadTxn) across the transaction()'s commit; finish it afterward to trigger the deferred
	// doneReadTxn commit.
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
		assert.equal(
			context.transaction.open,
			TRANSACTION_STATE.LINGERING,
			'premise: the open iterator must defer the commit (LINGERING)'
		);
		while (!(await iterator.next()).done);
		// the deferred commit runs from the iterator's onDone; give its async resolution a beat
		for (let i = 0; i < 200 && !(await LingerTable.get(writeId)); i++) await delay(10);
		return context;
	}

	it('commits the staged write once the iterator completes', async function () {
		this.timeout(15000);
		await commitWithOpenIterator('linger-write');
		const record = await LingerTable.get('linger-write');
		assert.ok(record, 'the write staged during the lingering transaction must be committed, not dropped');
		assert.equal(record.v, 42);
		await delay(50); // unhandledRejection lands on a later event-loop turn
		assert.deepEqual(unhandled, [], 'the deferred commit must not leak an unhandled rejection');
	});

	it('a write after the transaction went lingering commits independently; the lingering write still lands', async function () {
		this.timeout(15000);
		// The transactional wrapper only reuses a context transaction that is OPEN (Resource.ts), so a
		// put against the same context after LINGERING runs on a fresh transaction and commits
		// immediately — it must not disturb the lingering transaction's deferred writes. (Internal
		// paths that reach a LINGERING transaction via txnForContext stage into the retained native
		// transaction and ride the same deferred commit as the pre-lingering writes pinned above.)
		let iterator;
		const context = {};
		await transaction(context, async () => {
			const results = await LingerTable.search({ conditions: [] }, context);
			iterator = results[Symbol.asyncIterator]();
			await iterator.next();
			await LingerTable.put({ id: 'linger-early', v: 1 }, context);
		});
		const lingeringTxn = context.transaction;
		assert.equal(lingeringTxn.open, TRANSACTION_STATE.LINGERING);
		await LingerTable.put({ id: 'linger-late', v: 2 }, context);
		assert.notEqual(context.transaction, lingeringTxn, 'premise: the late write ran on a fresh transaction');
		assert.ok(await LingerTable.get('linger-late'), 'the independent write must be committed immediately');
		while (!(await iterator.next()).done);
		for (let i = 0; i < 200 && !(await LingerTable.get('linger-early')); i++) await delay(10);
		assert.ok(await LingerTable.get('linger-early'), 'the lingering write must still be committed');
		await delay(50); // unhandledRejection lands on a later event-loop turn
		assert.deepEqual(unhandled, [], 'the deferred commit must not leak an unhandled rejection');
	});

	it('a failing deferred commit is logged and aborted, not an unhandled rejection', async function () {
		this.timeout(15000);
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = LingerTable.primaryStore.store.db;
		let forcedFailures = 0;
		let context;
		try {
			context = await commitWithOpenIterator('linger-fail', () => {
				// arm after the transaction is set up: fail the deferred native commit terminally
				Transaction.prototype.commit = function (...args) {
					if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
					forcedFailures++;
					return Promise.reject(Object.assign(new Error('forced terminal failure'), { code: 'ERR_CORRUPTION' }));
				};
			});
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		assert.ok(forcedFailures > 0, 'premise: the deferred commit must have run and failed');
		assert.equal(await LingerTable.get('linger-fail'), undefined, 'the failed write is not committed');
		// unhandledRejection is emitted on a later event-loop turn; drain before asserting
		await delay(100);
		assert.deepEqual(unhandled, [], 'a deferred-commit failure must be caught and logged, never unhandled');
		assert.equal(
			context.transaction.writes.length,
			0,
			'the failed deferred commit must abort so staged writes (and their blob files) are cleaned up'
		);
	});
});
