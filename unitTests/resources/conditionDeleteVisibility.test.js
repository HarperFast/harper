const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// rangeReadActivity.test.js pins the read side of this mechanism (search() visibility).
// delete({ conditions, isCollection: true }) scans and then writes, so a scan that cannot see the
// transaction's staged writes destroys rows rather than merely hiding them (harper#2506).
describe('condition-driven delete inside a request transaction', function () {
	let Rows;
	before(async function () {
		// LMDBTransaction.getReadTxn hands out a plain read-only MVCC snapshot with no view of pending
		// writes on any access pattern, so these cases cannot pass on LMDB, and the deprecated engine
		// is not being changed for them. Declared and skipped so the gap is recorded, not absent.
		if (isLMDB) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			database: 'conditionDeleteVisibility',
			table: 'Rows',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'bucket', indexed: true },
			],
		});
		if (Rows.indexingOperation) await Rows.indexingOperation;
	});

	// the delete overwrites `select` on the target it is handed, so each case gets its own
	const matching = () => ({ conditions: [{ attribute: 'bucket', value: 'target' }], isCollection: true });

	it('a staged write that leaves the predicate keeps the row out of the delete', async function () {
		await Rows.put({ id: 1, bucket: 'target' });
		const context = {};
		await transaction(context, async () => {
			await Rows.put({ id: 1, bucket: 'moved' }, context);
			await Rows.delete(matching(), context);
		});
		const row = await Rows.get(1);
		assert.ok(row, 'the staged write moved the row out of the predicate, so the delete must not destroy it');
		assert.equal(row.bucket, 'moved');
	});

	it('a staged write that enters the predicate puts the row in the delete', async function () {
		await Rows.put({ id: 2, bucket: 'elsewhere' });
		const context = {};
		await transaction(context, async () => {
			await Rows.put({ id: 2, bucket: 'target' }, context);
			await Rows.delete(matching(), context);
		});
		assert.equal(await Rows.get(2), null, 'the staged write moved the row into the predicate, so it must be deleted');
	});
});
