/**
 * harper#2224 — save()'s adopt branch, taken by every blind write, seeded none of the per-handle
 * bookkeeping getReadTxn() establishes, so `undefined++` made readTxnsUsed NaN and abort() never
 * released the native transaction or its write intents.
 */
const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const {
	DatabaseTransaction,
	TRANSACTION_STATE,
	setTxnExpiration,
	isWriteSupervised,
	getTransactionQueueDepths,
} = require('#src/resources/DatabaseTransaction');

// RocksDB's DatabaseTransaction owns the bookkeeping under test; LMDBTransaction keeps its own
// counter independently and never adopts one of these handles.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('harper#2224 adopted read-handle bookkeeping', function () {
	let Blind, Chained;
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
		// A second database, so a write to it lands on a chain link rather than the head.
		Chained = table({
			table: 'AdoptedHandleChained',
			database: 'adoptedOther',
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

	it('is supervised by the long-transaction monitor without joining the read-tracked set', async function () {
		const trackedTxns = setTxnExpiration(30000);
		const readDepthBefore = getTransactionQueueDepths().readDepth;
		const { txn } = await blindWriteTransaction('supervised');
		assert.strictEqual(isWriteSupervised(txn), true, 'a blind write must not be invisible');
		// The read-tracked set and the depth metric it feeds keep their meaning: this transaction holds no
		// read snapshot, and getReadTxn() returns the already-adopted handle before it would register.
		txn.getReadTxn();
		assert.strictEqual(trackedTxns.has(txn), false);
		assert.strictEqual(getTransactionQueueDepths().readDepth, readDepthBefore);

		await txn.commit({ doneWriting: true });
		assert.strictEqual(isWriteSupervised(txn), false, 'supervision ends with ownership');
	});

	it('supervises the chain root, not the link that received the blind write', async function () {
		const context = {};
		const head = new DatabaseTransaction();
		opened.push(head);
		context.transaction = head;
		head.setContext(context);
		head.db = Blind.primaryStore;

		const other = await Chained.getResource({ id: null }, context, {});
		other._writeInvalidate('chain-write');
		const child = head.next;
		opened.push(child);
		assert.ok(child?.transaction, 'expected the chained link to have adopted a handle');
		assert.ok(Number.isFinite(head.timeout) && head.timeout > 0, 'the supervised root must have an armed timeout');

		// The monitor iterates members independently and chainStillActive() only looks downstream, so a
		// supervised child would be its own timeout root and could be reaped while the head is active.
		assert.strictEqual(isWriteSupervised(head), true);
		assert.strictEqual(isWriteSupervised(child), false);
	});

	it('keeps the root supervised when a read-only link in the same chain releases its handle', async function () {
		const context = {};
		const head = new DatabaseTransaction();
		opened.push(head);
		context.transaction = head;
		head.setContext(context);
		const resource = await Blind.getResource({ id: null }, context, {});
		resource._writeInvalidate('chain-hold'); // head blind-writes: the root is supervised

		const child = new DatabaseTransaction();
		opened.push(child);
		head.next = child;
		child.root = head;
		child.db = Chained.primaryStore;
		child.getReadTxn(); // a read-only link, which never claimed supervision
		child.doneReadTxn();

		// Membership is keyed on the root, so removing it on any link's detach would leave the head
		// holding write intents with nothing to reap it — the gap this supervision exists to close.
		assert.strictEqual(isWriteSupervised(head), true);
	});

	it('reaps a blind-write transaction that runs past the open-transaction limit', async function () {
		const context = {};
		const txn = new DatabaseTransaction();
		opened.push(txn);
		context.transaction = txn;
		txn.setContext(context);
		const resource = await Blind.getResource({ id: null }, context, {});

		// Before the write: addWrite arms the idle limit from the expiration current at that moment.
		setTxnExpiration(20);
		try {
			resource._writeInvalidate('over-time');
			assert.strictEqual(isWriteSupervised(txn), true);
			const deadline = Date.now() + 5000;
			while (txn.open !== TRANSACTION_STATE.CLOSED && Date.now() < deadline) await delay(20);
		} finally {
			setTxnExpiration(30000);
		}
		// Not just visible: the monitor actually acts. Before this, nothing ever forced a release.
		assert.strictEqual(txn.open, TRANSACTION_STATE.CLOSED, 'the monitor must reap what it supervises');
		assert.strictEqual(txn.transaction, null);
		assert.strictEqual(isWriteSupervised(txn), false);
	});
	it('aborts every owned handle when a supervised multi-database transaction fails', async function () {
		const { txn: head, context } = await blindWriteTransaction('root-abort');
		const other = await Chained.getResource({ id: null }, context, {});
		other._writeInvalidate('child-abort');
		const child = head.next;
		opened.push(child);
		assert.ok(child?.transaction, 'expected both database links to own handles');

		head.abort();

		assert.strictEqual(head.transaction, null);
		assert.strictEqual(child.transaction, null);
		assert.deepStrictEqual(child.writes, []);
		assert.strictEqual(head.next, null);
		assert.strictEqual(isWriteSupervised(head), false);
	});

	it('reaps a chain whose write landed on a link, not on the root', async function () {
		const context = {};
		const head = new DatabaseTransaction();
		opened.push(head);
		context.transaction = head;
		head.setContext(context);
		// A read claims the head for the first database without arming its idle limit, and an unarmed
		// limit decays to NaN, which is never <= 0 — the chained shape would go unreaped forever.
		await Blind.get('chain-overtime-seed', context);
		head.timeout = undefined; // the read's own arming is not what the chained write can rely on

		setTxnExpiration(20);
		try {
			const other = await Chained.getResource({ id: null }, context, {});
			other._writeInvalidate('chain-overtime');
			const child = head.next;
			opened.push(child);
			assert.ok(child?.transaction, 'expected a chained link to have taken the write');
			assert.strictEqual(isWriteSupervised(head), true);

			const deadline = Date.now() + 5000;
			while (head.open !== TRANSACTION_STATE.CLOSED && Date.now() < deadline) await delay(20);
		} finally {
			setTxnExpiration(30000);
		}
		assert.strictEqual(head.open, TRANSACTION_STATE.CLOSED, 'the logical transaction must be reaped');
		assert.strictEqual(isWriteSupervised(head), false);
	});

	it('keeps the root supervised while any link in the chain still claims it', async function () {
		const context = {};
		const head = new DatabaseTransaction();
		opened.push(head);
		context.transaction = head;
		head.setContext(context);
		const resource = await Blind.getResource({ id: null }, context, {});
		resource._writeInvalidate('two-claims'); // the head claims

		const other = await Chained.getResource({ id: null }, context, {});
		other._writeInvalidate('two-claims-child'); // and so does the child
		const child = head.next;
		opened.push(child);
		assert.strictEqual(head.writeSupervised, true);
		assert.strictEqual(child.writeSupervised, true);

		await child.commit({ doneWriting: true }); // one claim released
		assert.strictEqual(isWriteSupervised(head), true, 'the head still holds writes of its own');
	});

	it('releases a chained link’s handle when an ordinary abort cleans the head', async function () {
		const context = {};
		const head = new DatabaseTransaction();
		opened.push(head);
		context.transaction = head;
		head.setContext(context);
		await Blind.get('abort-link-seed', context);

		const other = await Chained.getResource({ id: null }, context, {});
		other._writeInvalidate('abort-link');
		const child = head.next;
		opened.push(child);
		const childHandle = child.transaction;
		assert.ok(childHandle, 'expected the chained link to have adopted a handle');
		let childAborts = 0;
		const nativeAbort = childHandle.abort.bind(childHandle);
		childHandle.abort = () => {
			childAborts++;
			return nativeAbort();
		};

		head.abort(); // an application error, not the monitor and not retry exhaustion

		// Only abortDueToTimeout() and abortChainAfterRetries() ever walked the chain, so this link's
		// handle and write intents used to survive the request that created them.
		assert.strictEqual(childAborts, 1, 'the chained link’s native handle must be released too');
		assert.strictEqual(child.transaction, null);
		assert.strictEqual(child.open, TRANSACTION_STATE.CLOSED);
	});

	it('evicts a closed, handle-less root whose claim is held by a chain link', async function () {
		const context = {};
		const head = new DatabaseTransaction();
		context.transaction = head;
		head.setContext(context);
		await Blind.get('evict-seed', context);
		const other = await Chained.getResource({ id: null }, context, {});
		other._writeInvalidate('evict-claim'); // the CHILD claims the root
		const child = head.next;
		assert.strictEqual(child.writeSupervised, true);

		// What a chained commit throwing synchronously leaves: the head closed with its handle gone, but
		// still enrolled, because the claiming link never detached. The head's own release path returns
		// early — the claim is not its own — so without an unconditional exit it is enrolled forever.
		head.releaseReadTxn();
		head.open = TRANSACTION_STATE.CLOSED;
		head.timeout = -1;
		assert.strictEqual(isWriteSupervised(head), true);
		const childHandle = child.transaction;
		assert.ok(childHandle, 'the child still holds the handle its write was staged into');

		setTxnExpiration(20);
		try {
			const deadline = Date.now() + 3000;
			while (isWriteSupervised(head) && Date.now() < deadline) await delay(20);
			// Asserted before the cleanup below: aborting the child would evict the root by itself.
			assert.strictEqual(isWriteSupervised(head), false, 'the monitor must be able to evict it unconditionally');
			// And the handle goes with it: dropping only the bookkeeping would strand a live native
			// transaction in neither registry, unreachable by anything that could ever release it.
			assert.strictEqual(child.transaction, null, 'eviction must release the handle it was tracking');
		} finally {
			setTxnExpiration(30000);
			try {
				child.abort();
			} catch {
				/* already finalized */
			}
			head.clearWrites();
		}
	});

	it('leaves crash-recovery replay unsupervised, so a timestamp group cannot be split', async function () {
		const context = {};
		const txn = new DatabaseTransaction();
		opened.push(txn);
		txn.isReplay = true; // set at construction in replayLogs, before any write
		context.transaction = txn;
		txn.setContext(context);
		const resource = await Blind.getResource({ id: null }, context, {});
		resource._writeInvalidate('replayed');
		assert.ok(txn.transaction, 'the replayed write still adopts a handle');
		assert.strictEqual(isWriteSupervised(txn), false);
	});

	it('detaches the handle when a synchronous commit succeeds', function () {
		const txn = new DatabaseTransaction();
		opened.push(txn);
		const handle = stubHandle();
		txn.attachOwnedTransaction(handle);
		txn.readTxnRefCount = 3; // holders of the handle being released
		txn.directCommitSync();
		assert.strictEqual(handle.calls.commitSync, 1);
		assert.strictEqual(txn.transaction, null);
		assert.strictEqual(txn.readTxnsUsed, 0);
		// Left set, a reused wrapper would carry these counts against a freshly adopted handle.
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
