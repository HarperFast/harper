require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const {
	DatabaseTransaction,
	TRANSACTION_STATE,
	getTransactionQueueDepths,
	isReleasedTransaction,
} = require('#src/resources/DatabaseTransaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

(isLMDB ? describe.skip : describe)('Read-only commit of a request transaction', () => {
	let ReadOnlyTable, OtherDbTable;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		ReadOnlyTable = table({
			table: 'ReadOnlyCommitTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		OtherDbTable = table({
			table: 'ReadOnlyCommitOtherDbTable',
			database: 'read_only_commit_other',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		for (let id = 1; id <= 5; id++) await ReadOnlyTable.put(id, { name: 'record ' + id });
		await OtherDbTable.put(1, { name: 'other' });
	});
	function countPerformCommit(txn) {
		const counter = { callCount: 0 };
		const performCommit = txn.performCommit;
		txn.performCommit = function (...args) {
			counter.callCount++;
			return performCommit.apply(this, args);
		};
		return counter;
	}

	function captureHandle(txn) {
		const captured = { handle: undefined, aborts: 0 };
		const getReadTxn = txn.getReadTxn;
		txn.getReadTxn = function (...args) {
			const handle = getReadTxn.apply(this, args);
			if (handle && !captured.handle) {
				captured.handle = handle;
				const abort = handle.abort;
				handle.abort = function () {
					captured.aborts++;
					return abort.call(this);
				};
			}
			return handle;
		};
		return captured;
	}

	it('releases the read handle of a GET by id without entering performCommit', async function () {
		let performCommit;
		const context = {};
		let txn, captured, readDepthInScope;
		const record = await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			captured = captureHandle(scopeTxn);
			const result = await ReadOnlyTable.get(2, context);
			readDepthInScope = getTransactionQueueDepths().readDepth;
			return result;
		});
		assert.equal(record.name, 'record 2');
		assert.ok(captured.handle, 'premise: the read went through the scope transaction');
		assert.equal(performCommit.callCount, 0, 'the final commit must take the read-only path');
		assert.equal(captured.aborts, 1, 'the native handle is aborted exactly once');
		assert.equal(txn.transaction, null, 'the handle is detached');
		assert.equal(txn.readTxnsUsed, 0);
		assert.equal(txn.open, TRANSACTION_STATE.CLOSED);
		assert.ok(isReleasedTransaction(context.transaction), 'the context slot is released');
		assert.ok(
			getTransactionQueueDepths().readDepth < readDepthInScope,
			'the long-transaction monitor no longer tracks it'
		);
		assert.equal(txn.timestamp, 0);
	});

	it('resolves with the scope timestamp and resets it', async function () {
		let performCommit;
		const timestamp = Date.now() - 1000;
		const context = { timestamp };
		let txn;
		await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			await ReadOnlyTable.get(1, context);
		});
		assert.equal(performCommit.callCount, 0);
		assert.equal(txn.timestamp, 0);
		const direct = new DatabaseTransaction({ scopeOwned: true });
		direct.timestamp = timestamp;
		const directCommits = countPerformCommit(direct);
		assert.deepEqual(direct.commit({ doneWriting: true }), { txnTime: timestamp });
		assert.equal(directCommits.callCount, 0, 'a scope that never read has no handle to release');
		assert.equal(direct.open, TRANSACTION_STATE.CLOSED);
	});

	it('still awaits and runs a staged completion', async function () {
		let performCommit;
		const context = {};
		let completed = false;
		let txn;
		await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			await ReadOnlyTable.get(3, context);
			scopeTxn.stageCompletion(
				new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
					completed = true;
				})
			);
		});
		assert.ok(completed, 'the commit waited for the completion');
		assert.equal(performCommit.callCount, 1, 'a staged completion takes the general path');
		assert.equal(txn.open, TRANSACTION_STATE.CLOSED);
		assert.ok(isReleasedTransaction(context.transaction));
	});

	it('rejects with a staged completion that fails', async function () {
		let performCommit;
		const expected = new Error('completion failed');
		await assert.rejects(
			transaction({}, async (scopeTxn) => {
				performCommit = countPerformCommit(scopeTxn);
				await ReadOnlyTable.get(3, {});
				scopeTxn.stageCompletion(Promise.reject(expected));
			}),
			(error) => error === expected
		);
		assert.equal(performCommit.callCount, 1);
	});

	it('keeps the handle for a search iterator still open at commit, and releases it when the iterator ends', async function () {
		let performCommit;
		const context = {};
		let txn, iterator, handle;
		await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			const results = ReadOnlyTable.search([{ attribute: 'id', comparator: 'greater_than', value: 0 }], context);
			iterator = results[Symbol.asyncIterator]();
			assert.equal((await iterator.next()).value.id, 1);
			handle = scopeTxn.transaction;
		});
		assert.ok(handle, 'premise: the search holds the scope handle');
		assert.equal(performCommit.callCount, 1, 'an outstanding iterator takes the general path');
		assert.equal(txn.transaction, handle, 'the iterator still owns the handle');
		const remaining = [];
		for (let step = await iterator.next(); !step.done; step = await iterator.next()) remaining.push(step.value.id);
		assert.deepEqual(remaining, [2, 3, 4, 5], 'the retained results stay consumable');
		assert.equal(txn.transaction, null, 'the last iterator released the handle');
		assert.ok(isReleasedTransaction(context.transaction));
	});

	it('takes the general path for a scope that wrote, and commits the write', async function () {
		let performCommit;
		const context = {};
		await transaction(context, async (scopeTxn) => {
			performCommit = countPerformCommit(scopeTxn);
			await ReadOnlyTable.get(4, context);
			await ReadOnlyTable.put(6, { name: 'written' }, context);
		});
		assert.equal(performCommit.callCount, 1);
		assert.equal((await ReadOnlyTable.get(6)).name, 'written');
		await ReadOnlyTable.delete(6);
	});

	it('takes the general path for a scope that read a second database', async function () {
		let performCommit;
		const context = {};
		let txn;
		await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			await ReadOnlyTable.get(1, context);
			await OtherDbTable.get(1, context);
		});
		assert.ok(performCommit.callCount >= 1, 'a chained store takes the general path');
		for (let link = txn; link; link = link.next) {
			assert.equal(link.open, TRANSACTION_STATE.CLOSED);
			assert.ok(!link.transaction, 'every link released its handle');
		}
		assert.ok(isReleasedTransaction(context.transaction));
	});

	it('takes the general path for a scope holding a record lock, releasing it', async function () {
		let performCommit;
		const context = {};
		let txn;
		await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			await ReadOnlyTable.lock(5, undefined, context);
			assert.ok(scopeTxn.recordLocks, 'premise: the lock is held by the scope');
		});
		assert.equal(performCommit.callCount, 1);
		assert.ok(!txn.recordLocks, 'the commit released the lock');
		const nextContext = {};
		await transaction(nextContext, () => ReadOnlyTable.lock(5, undefined, nextContext));
	});

	it('finishes a final scope commit that follows a mid-scope commit', async function () {
		let performCommit;
		const context = {};
		let txn;
		await transaction(context, async (scopeTxn) => {
			txn = scopeTxn;
			performCommit = countPerformCommit(scopeTxn);
			await ReadOnlyTable.put(7, { name: 'mid-scope' }, context);
			await scopeTxn.commit();
			assert.equal(scopeTxn.open, TRANSACTION_STATE.OPEN, 'premise: the mid-scope commit rotated the scope');
			assert.equal((await ReadOnlyTable.get(7, context)).name, 'mid-scope');
			performCommit.callCount = 0;
		});
		assert.equal(performCommit.callCount, 0, 'nothing was staged after the rotation');
		assert.equal(txn.open, TRANSACTION_STATE.CLOSED);
		assert.equal(txn.transaction, null);
		assert.equal(txn.snapshotFree, false, 'the scope flags end with the scope');
		assert.ok(isReleasedTransaction(context.transaction));
		await ReadOnlyTable.delete(7);
	});

	it("reads the context's signal only at its first write", async function () {
		const controller = new AbortController();
		let signalReads = 0;
		const context = {
			get signal() {
				signalReads++;
				return controller.signal;
			},
		};
		await transaction(context, () => ReadOnlyTable.get(1, context));
		assert.equal(signalReads, 0, 'a read-only scope never asks its transport for a signal');
		await transaction(context, async () => {
			await ReadOnlyTable.put(8, { name: 'first write' }, context);
			await ReadOnlyTable.put(9, { name: 'second write' }, context);
		});
		assert.equal(signalReads, 1, 'the first admitted write resolves the signal once');
		await ReadOnlyTable.delete(8);
		await ReadOnlyTable.delete(9);
	});

	it('still refuses the final commit of a poisoned scope', async function () {
		let performCommit;
		const context = {};
		await assert.rejects(
			transaction(context, async (scopeTxn) => {
				performCommit = countPerformCommit(scopeTxn);
				await ReadOnlyTable.get(1, context);
				scopeTxn.timedOut = true;
			}),
			/exceeding the maximum open-transaction time/
		);
		assert.equal(performCommit.callCount, 0);
	});
});
