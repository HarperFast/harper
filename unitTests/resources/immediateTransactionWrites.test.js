const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { isReleasedTransaction, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// A table call that finds no transaction on its context — including the released placeholder a
// completed scope leaves in the slot — gets an ImmediateTransaction from txnForContext, installed on
// the context and reporting OPEN, so every later call on that context joins it. It is also the only
// transaction that opens its native handle inside its own commit(), which is what used to leave that
// handle, and every write staged into it, dropped uncommitted (issue #2288).
describe('Writes through an ImmediateTransaction installed on a context', () => {
	let A, B, Audited;
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		A = table({ table: 'ImmediateA', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
		B = table({ table: 'ImmediateB', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
		Audited = table({
			table: 'ImmediateAudited',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
			audit: true,
		});
	});

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

	// The two writes of the failing handler, on the same installed transaction. Each commits on its
	// own — the documented expectation for a context whose transaction has completed — so the second
	// must not depend on, or disturb, the first.
	it("commits each of a handler's successive writes, across two tables", async function () {
		await A.put('seed', { v: 0 }, {});
		await A.put('staged', { v: 1 }, {});
		const context = {};
		const immediate = await installImmediateTransaction(context);

		await A.patch({ id: 'staged', v: 2 }, context);
		assert.equal(immediate.writes.length, 0, 'each write commits individually, clearing what it committed');
		await B.put('second-table', { v: 3 }, context);

		assert.equal((await A.get('staged')).v, 2, 'the update must be durable');
		assert.ok(await B.get('second-table'), 'and so must the write that follows it');
		assert.equal(immediate.writes.length, 0);
	});

	// The record and its audit/transaction-log entry batch onto the same native handle, so a write
	// committed through this path must carry its entry too — without it the record would be durable
	// locally and never replicate, which is worse than the symmetric loss it replaced.
	(isLMDB ? it.skip : it)('commits the audit entry with the record', async function () {
		await A.put('seed', { v: 0 }, {});
		const context = {};
		await installImmediateTransaction(context);

		await Audited.put('audited-write', { v: 7 }, context);

		assert.ok(await Audited.get('audited-write'), 'the record must be durable');
		const audited = [...Audited.auditStore.getRange({ start: 1 })].map((entry) => entry.getValue(Audited.primaryStore));
		assert.ok(
			audited.some((record) => record?.id === 'audited-write'),
			'the write must have committed its audit entry as well as its record'
		);
	});

	// The slot reaches the released placeholder mid-handler exactly as it did in production: a commit
	// made while search iterators are still streaming defers its context release, and the last
	// iterator to drain completes it — after which the handler is still running and still writing.
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
