require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { getTransactionQueueDepths } = require('#src/resources/DatabaseTransaction');

describe('Transaction queue depth metrics', () => {
	let QueueTest;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		QueueTest = table({
			table: 'QueueDepthTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	it('returns the expected shape and resets high-water marks on read', function () {
		const depths = getTransactionQueueDepths();
		for (const key of ['writeDepth', 'writeMaxDepth', 'readDepth', 'readMaxDepth']) {
			assert.equal(typeof depths[key], 'number', `${key} should be a number`);
			assert.ok(depths[key] >= 0, `${key} should be non-negative`);
		}
		// After reading, the high-water marks are reset to the current instantaneous depth, so an
		// immediate second read (with no intervening activity) reports maxDepth === depth.
		const after = getTransactionQueueDepths();
		assert.equal(after.writeMaxDepth, after.writeDepth);
		assert.equal(after.readMaxDepth, after.readDepth);
	});

	it('records a committed write on the write-queue high-water mark, then drains to zero', async function () {
		getTransactionQueueDepths(); // reset the sampling window
		await QueueTest.put(1, { name: 'first' });
		const depths = getTransactionQueueDepths();
		// The commit resolved before put() returned, so the instantaneous depth is back to zero, but the
		// high-water mark captured the in-flight commit.
		assert.ok(depths.writeMaxDepth >= 1, `writeMaxDepth should have captured the commit, got ${depths.writeMaxDepth}`);
		assert.equal(depths.writeDepth, 0, 'write depth should drain to zero after the commit settles');
	});

	it('reflects an open read transaction in the read-queue depth', async function () {
		getTransactionQueueDepths(); // reset the sampling window
		await QueueTest.put(2, { name: 'second' });
		let observedReadDepth = 0;
		await transaction({}, async (context) => {
			// A read inside the transaction opens a tracked read snapshot.
			await QueueTest.get(2, context);
			observedReadDepth = getTransactionQueueDepths().readDepth;
		});
		assert.ok(observedReadDepth >= 1, `an open read transaction should be counted, got ${observedReadDepth}`);
	});
});
