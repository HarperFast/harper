const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { isReleasedTransaction, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');

// A table call that finds no transaction on its context — including the released placeholder a
// completed scope leaves in the slot — gets an ImmediateTransaction from txnForContext, which is
// installed on the context and reports OPEN, so every later call on that context joins it. It is
// the one transaction that opens its native handle inside its own commit()'s save loop rather than
// before it (its getReadTxn never opens one), which is what made commit() drop the handle holding
// every staged write: the caller's await resolved, nothing was logged, and the record was absent
// (issue #2288).
describe('Writes through an ImmediateTransaction installed on a context', () => {
	let A, B;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		A = table({ table: 'ImmediateA', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
		B = table({ table: 'ImmediateB', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
	});

	// The intervening table call of issue #2288's trace: a read on a context whose transaction has
	// completed is what puts the ImmediateTransaction in the slot for the writes that follow.
	async function installImmediateTransaction(context) {
		await A.getResource('seed', context, {});
		assert.equal(context.transaction.open, TRANSACTION_STATE.OPEN, 'premise: the slot must now look open');
		assert.equal(context.transaction.writes.length, 0);
		return context.transaction;
	}

	it('commits a write made after the context transaction completed', async function () {
		await A.put('seed', { v: 0 }, {});
		const context = {};
		await transaction(context, async () => {
			await A.put('scoped', { v: 1 }, context);
		});
		assert.ok(isReleasedTransaction(context.transaction), 'premise: the completed scope released the slot');
		await installImmediateTransaction(context);

		await A.put('after-release', { v: 2 }, context);

		assert.ok(await A.get('after-release'), 'the write must be durable, not silently discarded');
	});

	// Both writes of the failing POST /Cluster handler: the first stages (a tracked-instance update
	// defers its save to commit), the second triggers the commit that has to carry both.
	it('commits every write staged on it, across two tables', async function () {
		await A.put('seed', { v: 0 }, {});
		await A.put('staged', { v: 1 }, {});
		const context = {};
		const immediate = await installImmediateTransaction(context);

		await A.patch({ id: 'staged', v: 2 }, context);
		await B.put('second-table', { v: 3 }, context);

		assert.equal((await A.get('staged')).v, 2, 'the staged update must be durable');
		assert.ok(await B.get('second-table'), 'and so must the write that triggered the commit');
		assert.equal(immediate.writes.length, 0, 'the commit must have cleared what it committed');
	});

	// The slot reaches the released placeholder mid-handler exactly as it did in production: a
	// commit made while search iterators are still streaming defers its context release, and the
	// last iterator to drain completes it — after which the handler is still running and still
	// writing.
	it('commits writes made after a deferred context release completes mid-handler', async function () {
		await A.put('seed', { v: 0 }, {});
		const context = {};
		const results = await A.search([{ attribute: 'v', comparator: 'greater_than', value: -1 }], context);
		assert.notEqual(context.transaction.open, TRANSACTION_STATE.OPEN, 'premise: the scope already committed');
		for await (const record of results) assert.ok(record);
		assert.ok(isReleasedTransaction(context.transaction), 'premise: draining completed the deferred release');
		await installImmediateTransaction(context);

		await A.put('after-drain', { v: 4 }, context);
		await B.put('after-drain', { v: 5 }, context);

		assert.ok(await A.get('after-drain'), 'a write after the deferred release must be durable');
		assert.ok(await B.get('after-drain'));
	});
});
