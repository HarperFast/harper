/**
 * harper#2222 — with `storage.debugLongTransactions: true`, useReadTxn() must not throw on a
 * transaction whose read handle did not come from getReadTxn()'s fresh-handle branch. search() is
 * its only caller, which is why the existing debugLongTransactions suites never covered it.
 */
const assert = require('node:assert');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

describe('harper#2222 debugLongTransactions reads', function () {
	const modulePath = require.resolve('#src/resources/DatabaseTransaction');
	let DatabaseTransaction, ImmediateTransaction, TRANSACTION_STATE, priorFlag, sharedModule;

	before(function () {
		priorFlag = env.get(CONFIG_PARAMS.STORAGE_DEBUGLONGTRANSACTIONS);
		env.setProperty(CONFIG_PARAMS.STORAGE_DEBUGLONGTRANSACTIONS, true);
		// The flag is captured in a load-time const, so this needs its own copy of the module. The
		// shared one goes back afterwards: it owns the trackedTxns set and the long-transaction
		// monitor that other suites drive.
		sharedModule = require.cache[modulePath];
		delete require.cache[modulePath];
		({ DatabaseTransaction, ImmediateTransaction, TRANSACTION_STATE } = require(modulePath));
	});

	after(function () {
		env.setProperty(CONFIG_PARAMS.STORAGE_DEBUGLONGTRANSACTIONS, priorFlag);
		require.cache[modulePath] = sharedModule;
	});

	it('reads through a handle the transaction adopted outside getReadTxn()', function () {
		const txn = new DatabaseTransaction();
		txn.transaction = { openTimer: 0 }; // what save() assigns when a write opens the handle first
		assert.strictEqual(txn.useReadTxn(), txn.transaction);
		assert.strictEqual(txn.stackTraces.length, 1);
	});

	it('reads on an ImmediateTransaction (getReadTxn returns no handle)', function () {
		const txn = new ImmediateTransaction({});
		assert.strictEqual(txn.useReadTxn(), undefined);
		// No handle means the monitor never tracks it, so traces would only accumulate unread.
		assert.strictEqual(txn.stackTraces, undefined);
	});

	it('reads on a transaction that is no longer open', function () {
		const txn = new DatabaseTransaction();
		txn.open = TRANSACTION_STATE.CLOSED;
		assert.strictEqual(txn.useReadTxn(), undefined);
		assert.strictEqual(txn.stackTraces, undefined);
	});
});
