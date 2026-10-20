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
const rocksOnly = isLMDB ? it.skip : it;
const lmdbOnly = isLMDB ? it : it.skip;

describe('harper#3308 read references against a detached handle', function () {
	let Refs;
	const opened = [];

	before(async function () {
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
	// the regression fails instead of hanging the run. Callers that swallow the throw check `exhausted`.
	function boundDrain(txn, limit = 1000) {
		const doneReadTxn = txn.doneReadTxn;
		const budget = { calls: 0, exhausted: false };
		txn.doneReadTxn = function (...args) {
			if (++budget.calls > limit) {
				budget.exhausted = true;
				throw new Error(`doneReadTxn() called ${budget.calls} times: abort() is spinning`);
			}
			return doneReadTxn.apply(this, args);
		};
		return budget;
	}

	// The instance method reads through txnForContext(); the static one opens a new transaction once the
	// context's is no longer OPEN.
	async function searchThroughContext(context, target = { conditions: [] }) {
		const resource = await Refs.getResource({ id: null }, context, {});
		return resource.search(target);
	}

	async function drain(results) {
		let count = 0;
		for await (const _record of results) count++;
		return count;
	}

	rocksOnly('a read after commit takes no reference, and abort() then returns', async function () {
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

	rocksOnly('searches after commit, streamed, counted, or failing, leave the counter at 0', async function () {
		const { txn, context } = newTransaction();
		txn.getReadTxn();
		await txn.commit();
		const useReadTxn = txn.useReadTxn;
		let searches = 0;
		txn.useReadTxn = function (...args) {
			searches++;
			return useReadTxn.apply(this, args);
		};
		assert.equal(await drain(await searchThroughContext(context)), 5);
		const page = await searchThroughContext(context, { conditions: [], count: 'exact', limit: 2 });
		assert.equal(page.length, 2);
		assert.equal(page.recordCount, 5);
		await assert.rejects(async () =>
			drain(await searchThroughContext(context, { conditions: [{ attribute: 'id', comparator: 'bogus', value: 1 }] }))
		);
		assert.equal(searches, 3, 'premise: each search read through the committed transaction');
		assert.equal(txn.transaction, null);
		assert.equal(txn.readTxnsUsed, 0);
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0);
	});

	rocksOnly('a commit that fails after reads in its detached window rejects with its own error', async function () {
		this.timeout(15000);
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = Refs.primaryStore.store.db;
		const context = {};
		let txn,
			budget,
			failures = 0;
		try {
			await assert.rejects(
				transaction(context, async () => {
					txn = context.transaction;
					budget = boundDrain(txn);
					await Refs.get('r0', context);
					await Refs.put({ id: 'fails', v: 1 }, context);
					Transaction.prototype.commit = function (...args) {
						if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
						failures++;
						return Promise.reject(Object.assign(new Error('forced commit failure'), { code: 'ERR_CORRUPTION' }));
					};
					const commit = txn.commit();
					commit.catch(() => {});
					assert.equal(txn.transaction, null, 'premise: the in-flight commit detached the handle');
					for (let i = 0; i < 3; i++) assert.equal(await drain(await searchThroughContext(context)), 5);
					await commit;
				}),
				/forced commit failure/
			);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		assert.ok(failures > 0, 'premise: the native commit ran and failed');
		assert.equal(budget.exhausted, false, 'abort() must not spin on references taken with no handle');
		assert.equal(txn.readTxnsUsed, 0);
		assert.equal(await Refs.get('fails'), undefined);
		await Refs.put({ id: 'after-failure', v: 1 });
		assert.ok(await Refs.get('after-failure'), 'the thread keeps serving writes');
	});

	rocksOnly('abort() returns after the handle is force-released under open iterators', function () {
		const { txn } = newTransaction();
		txn.getReadTxn();
		assert.ok(txn.useReadTxn());
		assert.ok(txn.useReadTxn());
		assert.equal(txn.readTxnsUsed, 3);
		txn.releaseReadTxn();
		assert.equal(txn.transaction, null);
		assert.equal(txn.readTxnsUsed, 0);
		boundDrain(txn);
		txn.abort(true);
		assert.equal(txn.readTxnsUsed, 0);
	});

	rocksOnly('abort() stops draining once the handle is gone', function () {
		const { txn } = newTransaction();
		txn.readTxnsUsed = 3;
		const budget = boundDrain(txn);
		txn.abort(true);
		assert.equal(budget.calls, 0);
	});

	rocksOnly('iterators finishing after a detach neither go negative nor release a later handle', async function () {
		const context = {};
		let txn, freshHandle, freshGeneration;
		await transaction(context, async () => {
			txn = context.transaction;
			const stale = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await stale.next();
			const stale2 = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await stale2.next();
			const staleHandle = txn.transaction;
			await txn.commit();
			assert.equal(txn.transaction, staleHandle, 'premise: the open iterators retain the handle');
			txn.releaseReadTxn();
			assert.equal(txn.readTxnsUsed, 0);
			await txn.commit();
			assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'premise: the scope reopened');
			const fresh = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
			await fresh.next();
			freshHandle = txn.transaction;
			freshGeneration = txn.readTxnGeneration;
			assert.ok(freshHandle && freshHandle !== staleHandle, 'premise: a new native handle');
			await Refs.put({ id: 'second-generation', v: 1 }, context);
			const freshCount = txn.readTxnsUsed;
			await assert.rejects(async () => {
				while (!(await stale.next()).done);
			}, /snapshot expired/);
			await stale2.return();
			assert.equal(txn.transaction, freshHandle, 'stale references must not release the fresh handle');
			assert.equal(txn.readTxnsUsed, freshCount, 'stale references must not move the fresh handle’s count');
			let rest = 0;
			while (!(await fresh.next()).done) rest++;
			assert.equal(rest, 5, 'the fresh iterator reads to the end on its own handle');
		});
		assert.equal(txn.transaction, null, 'the fresh handle is released once its own references return');
		assert.equal(txn.readTxnsUsed, 0);
		assert.ok(await Refs.get('second-generation'), 'the write staged on the fresh handle commits');
		txn.doneReadTxn(freshGeneration);
		assert.equal(txn.readTxnsUsed, 0, 'a return after release must not go negative');
	});

	lmdbOnly(
		'LMDB: a return for a force-released snapshot does not take a later snapshot’s reference',
		async function () {
			const context = {};
			let txn;
			await transaction(context, async () => {
				const stale = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
				await stale.next();
				for (txn = context.transaction; txn && !txn.readTxn; txn = txn.next);
				assert.ok(txn, 'premise: a link holds the search’s read snapshot');
				const staleGeneration = txn.readTxnGeneration;
				await txn.commit();
				assert.equal(txn.open, TRANSACTION_STATE.OPEN, 'premise: an LMDB mid-scope commit stays OPEN');
				txn.releaseReadTxn();
				assert.equal(txn.readTxn, null);
				await Refs.put({ id: 'lmdb-second-generation', v: 1 });
				const fresh = (await Refs.search({ conditions: [] }, context))[Symbol.asyncIterator]();
				await fresh.next();
				const freshSnapshot = txn.readTxn;
				// lmdb-js renews the same Txn object, so only the generation tells the snapshots apart.
				assert.ok(freshSnapshot && txn.readTxnGeneration !== staleGeneration, 'premise: a new read snapshot');
				const freshCount = txn.readTxnsUsed;
				await stale.return();
				assert.equal(txn.readTxn, freshSnapshot, 'a stale return must not release the fresh snapshot');
				assert.equal(txn.readTxnsUsed, freshCount);
				let rest = 0;
				while (!(await fresh.next()).done) rest++;
				assert.ok(rest >= 4, 'the fresh iterator reads to the end on its own snapshot');
			});
			assert.equal(txn.readTxnsUsed, 0);
		}
	);
});
