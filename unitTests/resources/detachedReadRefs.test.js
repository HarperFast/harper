/**
 * harper#3308 — readTxnsUsed counts references to the owned native handle, so it must be 0 whenever
 * there is no handle. A read reference taken while there was none (a read after commit) or returned
 * after its handle was detached must not move the counter, or abort()'s drain loop spins forever.
 */
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { DatabaseTransaction, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('harper#3308 read references against a detached handle', function () {
	let Refs;
	const opened = [];

	before(async function () {
		if (isLMDB) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Refs = table({
			table: 'DetachedReadRefs',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
		for (let i = 0; i < 5; i++) await Refs.put({ id: 'r' + i, v: i });
	});

	afterEach(function () {
		while (opened.length) {
			const txn = opened.pop();
			try {
				if (txn.transaction) txn.releaseReadTxn();
			} catch {
				/* already finalized by the test */
			}
		}
	});

	function newTransaction() {
		const context = {};
		const txn = new DatabaseTransaction();
		txn.db = Refs.primaryStore;
		context.transaction = txn;
		txn.setContext(context);
		opened.push(txn);
		return { txn, context };
	}

	// abort()'s drain loop is synchronous, so a mocha timeout can never interrupt it; bound it here so
	// the regression fails instead of hanging the run.
	function boundDrain(txn, limit = 1000) {
		const doneReadTxn = txn.doneReadTxn;
		let calls = 0;
		txn.doneReadTxn = function (...args) {
			if (++calls > limit) throw new Error(`doneReadTxn() called ${calls} times: abort() is spinning`);
			return doneReadTxn.apply(this, args);
		};
	}

	function retainIterator(txn) {
		const handle = txn.useReadTxn();
		assert.ok(handle, 'premise: the reference was taken on a live handle');
		return handle;
	}

	it('a read after commit takes no reference, and abort() then returns', async function () {
		const { txn } = newTransaction();
		txn.getReadTxn();
		await txn.commit();
		assert.equal(txn.open, TRANSACTION_STATE.CLOSED);
		assert.equal(txn.transaction, null, 'premise: commit with no iterators detaches the handle');
		for (let i = 0; i < 3; i++) assert.equal(txn.useReadTxn(), undefined, 'premise: no handle to read from');
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0, 'a reference to no handle must not be counted');
	});

	it('a search after commit leaves the counter at 0 once its results are consumed', async function () {
		const { txn, context } = newTransaction();
		txn.getReadTxn();
		await txn.commit();
		context.transaction = txn; // a reader that still holds the committed transaction
		const useReadTxn = txn.useReadTxn;
		let searches = 0;
		txn.useReadTxn = function (...args) {
			searches++;
			return useReadTxn.apply(this, args);
		};
		for (let i = 0; i < 3; i++) {
			// The instance method reads through txnForContext(); the static one would open a new transaction.
			const resource = await Refs.getResource({ id: null }, context, {});
			const results = await resource.search({ conditions: [] });
			let count = 0;
			for await (const _record of results) count++;
			assert.equal(count, 5);
		}
		assert.equal(searches, 3, 'premise: each search read through the committed transaction');
		assert.equal(txn.transaction, null);
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0);
	});

	it('abort() returns after the handle is force-released under open iterators', function () {
		const { txn } = newTransaction();
		txn.getReadTxn();
		retainIterator(txn);
		retainIterator(txn);
		assert.equal(txn.readTxnsUsed, 3);
		txn.releaseReadTxn(); // the long-transaction monitor's path
		assert.equal(txn.transaction, null);
		assert.equal(txn.readTxnsUsed, 0);
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0);
	});

	it('iterators finishing after a detach neither go negative nor release a later handle', async function () {
		const context = {};
		let txn, staleHandle, freshHandle, fresh;
		await transaction(context, async () => {
			txn = context.transaction;
			const stale = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await stale.next();
			const stale2 = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await stale2.next();
			staleHandle = txn.transaction;
			await txn.commit(); // mid-scope, with iterators open: the handle is retained for them
			assert.equal(txn.transaction, staleHandle, 'premise: the open iterators retain the handle');
			txn.releaseReadTxn(); // the long-transaction monitor's path
			assert.equal(txn.readTxnsUsed, 0);
			await txn.commit(); // nothing held now, so the scope reopens on a new generation
			assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'premise: the scope reopened');
			fresh = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await fresh.next();
			freshHandle = txn.transaction;
			assert.ok(freshHandle && freshHandle !== staleHandle, 'premise: a new native handle');
			const freshCount = txn.readTxnsUsed;
			// The iterators from the released handle finish now: one fails on its expired snapshot, the
			// other is closed by its consumer.
			await assert.rejects(async () => {
				while (!(await stale.next()).done);
			}, /snapshot expired/);
			await stale2.return();
			assert.equal(txn.transaction, freshHandle, 'stale references must not release the fresh handle');
			assert.equal(txn.readTxnsUsed, freshCount, 'stale references must not move the fresh handle’s count');
			let rest = 0;
			while (!(await fresh.next()).done) rest++;
			assert.equal(rest, 4, 'the fresh iterator reads to the end on its own handle');
		});
		assert.equal(txn.transaction, null, 'the fresh handle is released once its own references return');
		assert.equal(txn.readTxnsUsed, 0);
		txn.doneReadTxn(freshHandle); // an extra return after release
		assert.equal(txn.readTxnsUsed, 0, 'a return after release must not go negative');
	});
});
