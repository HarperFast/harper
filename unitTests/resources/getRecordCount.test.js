require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Table.getRecordCount', () => {
	let RecordCountTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		RecordCountTable = table({
			table: 'RecordCountTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});

		const N = 30;
		let last;
		for (let i = 0; i < N; i++) {
			last = RecordCountTable.put({ id: 'k-' + i, name: 'name-' + i });
		}
		await last;
	});

	it('returns the exact count when the loop completes within the time budget', async function () {
		const result = await RecordCountTable.getRecordCount();
		assert.equal(result.recordCount, 30);
		assert.equal(result.estimatedRange, undefined);
	});

	it('switches to the sampling estimator when the time budget is exhausted', async function () {
		// Force the early-exit branch by giving the loop a 0ms time budget.
		// This is the regression guard for the RocksDB entryCount bug: when
		// `entryCount` was undefined on RocksDB stores, `halfway` became NaN
		// and `entriesScanned < halfway` was always false, so the early-exit
		// never fired and getRecordCount silently full-scanned every table.
		// With a working entryCount we should drop into the sampling path
		// after the first iteration and return an `estimatedRange`.
		const result = await RecordCountTable.getRecordCount({ timeLimit: 0 });
		assert.ok(
			Array.isArray(result.estimatedRange),
			'expected getRecordCount to engage the sampling estimator (estimatedRange should be set)'
		);
		assert.equal(result.estimatedRange.length, 2);
	});

	it('keeps the sampling estimate within a sane factor of the true record count', async function () {
		// Guards the reverse-sample bound. With `timeLimit: 0` the forward pass yields after one entry
		// (limit=1) and the estimator runs. If the reverse loop is unbounded (rocksdb-js ignores the
		// getRange `limit`), it counts every live row, so `recordRate = (1 + entryCount)/2` and the
		// estimate scales with entryCount^2 -- the `record_count=20,000,000`-for-~105K-rows bug.
		const result = await RecordCountTable.getRecordCount({ timeLimit: 0 });
		assert.ok(
			result.recordCount > 0 && result.recordCount <= 30 * 4,
			`estimate ${result.recordCount} should track the ~30 live records, not an inflated key count`
		);
	});

	it('does not inflate the estimate when keys are repeatedly overwritten', async function () {
		// Defense-in-depth for the extrapolation *base* (distinct from the reverse-sample bound above).
		// Re-write the same keys many times so superseded versions accumulate across (mostly) uncompacted
		// SST files, driving rocksdb `estimate-num-keys` well above the live count. record_count must still
		// track the live rows, i.e. `entryCount` must stay the exact `getKeysCount`, not `getEstimatedKeyCount`.
		const InflationTable = table({
			table: 'RecordCountInflationTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const N = 40;
		const ROUNDS = 30;
		for (let r = 0; r < ROUNDS; r++) {
			let last;
			for (let i = 0; i < N; i++) {
				last = InflationTable.put({ id: 'k-' + i, name: 'v-' + r + '-' + i });
			}
			await last;
			InflationTable.primaryStore.flushSync?.();
		}

		// Precondition sanity: this test only discriminates when the physical estimate is actually
		// inflated above the live count. Surface when it can't (e.g. LMDB, or compaction kept up) so a
		// green run isn't over-read.
		const physicalEstimate = InflationTable.primaryStore.getEstimatedKeyCount?.() ?? N;
		if (physicalEstimate < N * 1.5) {
			console.warn(
				`getRecordCount inflation guard: estimate ${physicalEstimate} not meaningfully inflated vs ${N} live; assertion still valid but less discriminating`
			);
		}

		const result = await InflationTable.getRecordCount({ timeLimit: 0 });
		assert.ok(
			result.recordCount <= N * 2,
			`estimate ${result.recordCount} should track ${N} live records, not the inflated physical key count (${physicalEstimate})`
		);
	});

	it('returns a valid record count and range for a tiny table under a 0ms budget', async function () {
		// Edge case: a 1-row table with `timeLimit: 0`. `halfway` is 0, so the early-exit can't fire
		// (entriesScanned is never < 0) and the loop completes to an exact count rather than estimating
		// from a sample that would otherwise overlap its own tail. Guards against an inverted/!valid range.
		const TinyTable = table({
			table: 'RecordCountTinyTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await TinyTable.put({ id: 'solo', name: 'only-row' });

		const result = await TinyTable.getRecordCount({ timeLimit: 0 });
		const [lower, upper] = result.estimatedRange ?? [result.recordCount, result.recordCount];
		assert.ok(lower <= upper, `estimated range must be valid (got [${lower}, ${upper}])`);
		assert.ok(
			result.recordCount >= 1 && result.recordCount <= 10,
			`estimate ${result.recordCount} should track the single live row`
		);
	});
});
