require('../testUtils');
const assert = require('assert');
const {
	DatabaseTransaction,
	TRANSACTION_STATE,
	deferForCommitInFlight,
	isReleasedTransaction,
} = require('#src/resources/DatabaseTransaction');
const { LMDBTransaction } = require('#src/resources/LMDBTransaction');

function makeLMDBWrite(id, commit) {
	const store = {
		rootStore: { databaseName: 'commit-boundary-test' },
		name: 'records',
		getEntry() {},
		ifVersion(_key, _version, callback) {
			callback();
			return Promise.resolve(true);
		},
	};
	return { key: id, store, commit };
}

describe('Transaction native-submit boundary', () => {
	it('keeps the LMDB empty commit synchronous', function () {
		const transaction = new LMDBTransaction();
		const result = transaction.commit({});
		assert.ok(!result?.then, 'an empty LMDB commit must not acquire an asynchronous boundary');
		assert.equal(typeof result.txnTime, 'number');
	});

	it('cleans every LMDB chain link when a returned commit completion rejects', async function () {
		const expected = new Error('LMDB completion failed');
		const head = new LMDBTransaction();
		const child = new LMDBTransaction();
		const context = { transaction: head };
		head.setContext(context);
		child.setContext(context);
		head.next = child;
		child.root = head;
		let headSnapshotDone = 0;
		let childSnapshotDone = 0;
		head.readTxn = { done: () => headSnapshotDone++ };
		head.readTxnsUsed = 1;
		child.readTxn = { done: () => childSnapshotDone++ };
		child.readTxnsUsed = 1;
		head.writes.push(makeLMDBWrite(1, () => {}));
		child.writes.push(makeLMDBWrite(2, () => Promise.reject(expected)));

		await assert.rejects(head.commit({ doneWriting: true }), (error) => error === expected);

		assert.equal(head.open, TRANSACTION_STATE.CLOSED);
		assert.equal(child.open, TRANSACTION_STATE.CLOSED);
		assert.equal(head.writes.length, 0, 'the successful head must still surrender its reusable state');
		assert.equal(child.writes.length, 0, 'the rejecting child must be cleaned by the same failure funnel');
		assert.equal(headSnapshotDone, 1);
		assert.equal(childSnapshotDone, 1);
		assert.ok(isReleasedTransaction(context.transaction), 'the failed chain must release its context');
	});

	it('does not treat a pre-submit commit method as an unknown native outcome', function () {
		const transaction = new DatabaseTransaction();
		transaction.commitsInFlight = 1;
		transaction.committing = true;

		assert.equal(deferForCommitInFlight(transaction, undefined, 1), false);
		assert.ok(!transaction.timedOut, 'the ordinary commit-phase grace decides this pre-submit attempt');

		transaction.commitsInFlight = 0;
	});

	it('preserves and leaves protected post-submit work unpoisoned', function () {
		const transaction = new DatabaseTransaction();
		transaction.commitsInFlight = 1;
		transaction.commitSubmitted = true;
		transaction.nativeCommitSubmitted = true;
		transaction.sourceApply = true;
		transaction.deferredPoisonDeadline = -Infinity;

		assert.equal(deferForCommitInFlight(transaction, '/source', 1), true);
		assert.ok(!transaction.timedOut, 'source apply must not be poisoned after native submission');
		assert.equal(transaction.open, TRANSACTION_STATE.OPEN);

		transaction.commitsInFlight = 0;
	});

	it('protects an LMDB child when the chain root is a source apply', function () {
		const root = new DatabaseTransaction();
		const child = new LMDBTransaction();
		root.sourceApply = true;
		root.next = child;
		child.root = root;
		child.commitsInFlight = 1;
		child.nativeCommitSubmitted = true;
		root.commitSubmitted = true;
		root.deferredPoisonDeadline = -Infinity;

		assert.equal(deferForCommitInFlight(child, '/source-child', 1), true);
		assert.ok(!root.timedOut && !child.timedOut, 'the root protection must cover every storage-engine link');

		child.commitsInFlight = 0;
	});

	it('poisons ordinary follow-up work without clearing a submitted write', function () {
		const transaction = new DatabaseTransaction();
		const write = { key: 1 };
		transaction.writes.push(write);
		transaction.commitsInFlight = 1;
		transaction.commitSubmitted = true;
		transaction.nativeCommitSubmitted = true;
		transaction.deferredPoisonDeadline = -Infinity;

		assert.equal(deferForCommitInFlight(transaction, '/ordinary', 1), true);
		assert.equal(transaction.timedOut, true, 'fresh work must be rejected after the diagnostic grace');
		assert.equal(transaction.poisonedMidCommit, true, 'the already-started continuation remains allowed');
		assert.equal(transaction.writes[0], write, 'unknown submitted state must not be destructively cleaned');
		assert.equal(transaction.open, TRANSACTION_STATE.OPEN, 'the submitted attempt still owns its outcome');

		transaction.commitsInFlight = 0;
	});

	it('reclaims a submitted link read snapshot only once', function () {
		const transaction = new DatabaseTransaction();
		let iteratorCloses = 0;
		let snapshotReleases = 0;
		transaction.commitsInFlight = 1;
		transaction.commitSubmitted = true;
		transaction.nativeCommitSubmitted = true;
		transaction.sourceApply = true;
		transaction.transaction = {};
		transaction.closeOwnedReadIterators = () => iteratorCloses++;
		transaction.releaseReadTxn = () => snapshotReleases++;

		assert.equal(deferForCommitInFlight(transaction, undefined, 1), true);
		transaction.timeout = 0;
		assert.equal(deferForCommitInFlight(transaction, undefined, 1), true);
		assert.equal(iteratorCloses, 1);
		assert.equal(snapshotReleases, 1);

		transaction.commitsInFlight = 0;
	});
});
