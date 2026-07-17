require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { setCommitLatencyRecorder } = require('#src/resources/DatabaseTransaction');
// The commit-latency hook lives on the base DatabaseTransaction.commit() (RocksDB path). LMDB writes
// route through the separate LMDBTransaction.commit() override (resources/LMDBTransaction.ts), which
// does not call it — matching the existing RocksDB-only carve-outs in transaction.test.js.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Transaction commit latency metric', () => {
	let CommitLatencyTest;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		CommitLatencyTest = table({
			table: 'CommitLatencyTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	it('records the submit->settle duration when a write commit settles', async function () {
		if (isLMDB) return;
		const durations = [];
		setCommitLatencyRecorder((durationMs) => durations.push(durationMs));
		try {
			await CommitLatencyTest.put(1, { name: 'first' });
			// The duration is recorded in a `.then` on the commit promise; flush the microtask queue.
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			setCommitLatencyRecorder(undefined);
		}
		assert.ok(durations.length >= 1, 'expected at least one commit latency record');
		assert.equal(typeof durations[0], 'number', 'commit latency should be numeric');
		assert.ok(durations[0] >= 0, 'commit latency should be non-negative');
	});

	it('does not record when no recorder is registered', async function () {
		// Regression guard for the analytics-disabled fast path: with no recorder set, a commit must not
		// throw (the guard short-circuits before allocating the handler).
		setCommitLatencyRecorder(undefined);
		await CommitLatencyTest.put(2, { name: 'second' });
	});
});
