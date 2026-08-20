/**
 * harper#2224 — save()'s adopt branch, taken by every blind write, seeded none of the per-handle
 * bookkeeping getReadTxn() establishes, so `undefined++` made readTxnsUsed NaN and abort() never
 * released the native transaction or its write intents.
 */
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { DatabaseTransaction, TRANSACTION_STATE, setTxnExpiration } = require('#src/resources/DatabaseTransaction');

// RocksDB's DatabaseTransaction owns the bookkeeping under test; LMDBTransaction keeps its own
// counter independently and never adopts one of these handles.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('harper#2224 adopted read-handle bookkeeping', function () {
	let Blind;
	// A handle left open pins a read snapshot for the rest of the process and blocks blob reclamation.
	const opened = [];

	after(function () {
		setTxnExpiration(30000); // this suite reads trackedTxns through it; leave the default behind
	});

	afterEach(function () {
		while (opened.length) {
			const txn = opened.pop();
			try {
				if (txn.transaction) txn.abort();
			} catch {
				/* already finalized by the test */
			}
		}
	});

	before(function () {
		if (isLMDB) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Blind = table({
			table: 'AdoptedHandle',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
	});

	// Built the way replayLogs.ts does it: a resource with no id loads nothing, so the staged write is
	// the first thing to touch the transaction. Invalidating by id would create the handle in
	// getReadTxn() instead and test nothing here.
	async function blindWriteTransaction(id) {
		const context = {};
		const txn = new DatabaseTransaction();
		context.transaction = txn;
		txn.setContext(context);
		opened.push(txn);
		const resource = await Blind.getResource({ id: null }, context, {});
		assert.ok(!txn.transaction, 'nothing may have opened a handle yet, or this tests the wrong branch');
		resource._writeInvalidate(id);
		assert.ok(txn.transaction, 'expected the blind write to have adopted a native handle');
		return { txn, context };
	}

	function stubHandle({ abortThrows = false, commitThrows = false } = {}) {
		const calls = { abort: 0, commitSync: 0 };
		return {
			calls,
			openTimer: 0,
			abort() {
				calls.abort++;
				if (abortThrows) throw new Error('native abort failed');
			},
			commitSync() {
				calls.commitSync++;
				if (commitThrows) throw new Error('native commitSync failed');
			},
		};
	}

	it('seeds the base reference when a blind write adopts the handle', async function () {
		const { txn } = await blindWriteTransaction('seed');
		assert.strictEqual(txn.readTxnsUsed, 1);
		assert.strictEqual(txn.baseReadRefConsumed, false);
	});

	it('releases the adopted handle on abort, and completes wrapper cleanup', async function () {
		const { txn, context } = await blindWriteTransaction('abort');
		const handle = txn.transaction;
		let nativeAborts = 0;
		const nativeAbort = handle.abort.bind(handle);
		handle.abort = () => {
			nativeAborts++;
			return nativeAbort();
		};
		txn.abort();
		assert.strictEqual(nativeAborts, 1, 'the native transaction itself must be aborted, not just dropped');
		assert.strictEqual(txn.transaction, null, 'native handle must not outlive the abort');
		assert.strictEqual(txn.readTxnsUsed, 0);
		assert.strictEqual(txn.open, TRANSACTION_STATE.CLOSED);
		assert.deepStrictEqual(txn.writes, []);
		assert.strictEqual(context.transaction, null);
	});

	it('counts a read through an adopted handle instead of poisoning the count with NaN', async function () {
		const { txn } = await blindWriteTransaction('read');
		txn.useReadTxn();
		assert.strictEqual(txn.readTxnsUsed, 2);
		txn.doneReadTxn();
		assert.strictEqual(txn.readTxnsUsed, 1, 'the base reference is commit()’s to consume, not the iterator’s');
		assert.ok(txn.transaction, 'draining an iterator reference must not release the handle');
	});

	it('consumes the base reference exactly once across commit', async function () {
		const { txn } = await blindWriteTransaction('commit');
		await txn.commit({ doneWriting: true });
		assert.strictEqual(txn.baseReadRefConsumed, true);
		assert.strictEqual(txn.readTxnsUsed, 0);
		assert.strictEqual(txn.transaction, null);
		await txn.commit({ doneWriting: true }); // a second (wrapper) commit must not double-consume
		assert.strictEqual(txn.readTxnsUsed, 0);
	});

	it('takes a read reference on every getReadTxn, which is what the two guards below count', async function () {
		const txn = new DatabaseTransaction();
		opened.push(txn);
		txn.db = Blind.primaryStore;
		txn.getReadTxn();
		assert.strictEqual(txn.readTxnRefCount, 1);
		txn.getReadTxn();
		// Pins the increment the two guards below model with a hand-written count.
		assert.strictEqual(txn.readTxnRefCount, 2);
	});

	it('will not release a handle carrying staged writes when a source load disregards it', async function () {
		await Blind.put({ id: 'disregard', v: 'stale' });
		const context = {};
		const txn = new DatabaseTransaction();
		opened.push(txn);
		context.transaction = txn;
		txn.setContext(context);
		const resource = await Blind.getResource({ id: null }, context, {});
		resource._writeUpdate('disregard', { v: 'fresh' }, true);

		// A caching read holding the only outstanding reference — the shape an unpaired disregard
		// reaches after a detach zeroed the count.
		txn.readTxnRefCount = 1;
		txn.disregardReadTxn();

		assert.ok(txn.transaction, 'releasing the handle would abort the batch the write was staged into');
		await txn.commit({ doneWriting: true });
		assert.strictEqual((await Blind.get('disregard'))?.v, 'fresh');
	});

	it('clamps the read reference count instead of letting an unpaired release drive it negative', function () {
		const txn = new DatabaseTransaction();
		opened.push(txn);
		txn.readTxnRefCount = 0; // what detachOwnedTransaction() leaves behind
		txn.disregardReadTxn(); // unpaired: the matching getReadTxn's handle was detached under it
		assert.strictEqual(txn.readTxnRefCount, 0, 'a negative count would cancel a later handle’s references');
	});

	it('leaves an already-owned handle and its iterator references alone when a write stages into it', async function () {
		const context = {};
		const txn = new DatabaseTransaction();
		opened.push(txn);
		context.transaction = txn;
		txn.setContext(context);
		await Blind.get('interleaved', context); // read first: getReadTxn() creates and owns the handle
		const handle = txn.transaction;
		txn.useReadTxn(); // an outstanding search iterator
		assert.strictEqual(txn.readTxnsUsed, 2);

		const resource = await Blind.getResource({ id: null }, context, {});
		resource._writeInvalidate('interleaved');
		assert.strictEqual(txn.transaction, handle, 'a write must not swap the handle it stages into');
		assert.strictEqual(txn.readTxnsUsed, 2, 'the iterator reference must survive the write');
	});

	it('is never registered with the long-transaction monitor, even once it is read', async function () {
		const trackedTxns = setTxnExpiration(30000);
		const { txn } = await blindWriteTransaction('untracked');
		assert.strictEqual(trackedTxns.has(txn), false);
		// getReadTxn() returns the already-adopted handle before it reaches trackedTxns.add, so reading
		// does not register it either. Deliberate here, and tracked as its own follow-up (#2231).
		txn.getReadTxn();
		assert.strictEqual(trackedTxns.has(txn), false);
	});

	it('detaches the handle when a synchronous commit succeeds', function () {
		const txn = new DatabaseTransaction();
		opened.push(txn);
		const handle = stubHandle();
		txn.attachOwnedTransaction(handle);
		txn.directCommitSync();
		assert.strictEqual(handle.calls.commitSync, 1);
		assert.strictEqual(txn.transaction, null);
		assert.strictEqual(txn.readTxnsUsed, 0);
		assert.strictEqual(txn.readTxnRefCount, 0);
	});

	it('aborts and detaches when a synchronous commit fails, rethrowing the commit error', function () {
		const txn = new DatabaseTransaction();
		opened.push(txn);
		const handle = stubHandle({ commitThrows: true });
		txn.attachOwnedTransaction(handle);
		assert.throws(() => txn.directCommitSync(), /native commitSync failed/);
		assert.strictEqual(handle.calls.abort, 1, 'an uncommitted handle still holds its write intents');
		assert.strictEqual(txn.transaction, null);
		assert.strictEqual(txn.readTxnsUsed, 0);
	});

	it('completes wrapper cleanup when a failed synchronous commit also fails to abort', function () {
		const context = {};
		const txn = new DatabaseTransaction();
		opened.push(txn);
		context.transaction = txn;
		txn.setContext(context);
		txn.attachOwnedTransaction(stubHandle({ commitThrows: true, abortThrows: true }));
		assert.throws(() => txn.directCommitSync(), /native commitSync failed/);
		// abort() is what reclaims blobs a replayed write staged.
		assert.strictEqual(txn.open, TRANSACTION_STATE.CLOSED);
		assert.deepStrictEqual(txn.writes, []);
		assert.strictEqual(context.transaction, null);
	});

	it('completes wrapper cleanup even when the native abort throws', function () {
		const context = {};
		const txn = new DatabaseTransaction();
		opened.push(txn);
		context.transaction = txn;
		txn.setContext(context);
		txn.attachOwnedTransaction(stubHandle({ abortThrows: true }));
		txn.abort();
		assert.strictEqual(txn.transaction, null);
		assert.strictEqual(txn.readTxnsUsed, 0);
		assert.strictEqual(txn.open, TRANSACTION_STATE.CLOSED);
		assert.strictEqual(context.transaction, null);
	});
});
