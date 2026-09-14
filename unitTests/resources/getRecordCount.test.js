require('../testUtils');
const assert = require('node:assert');
const { AsyncLocalStorage } = require('node:async_hooks');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('Table.getRecordCount', () => {
	// Used instead of the ambient 500ms default in the within-budget cases below, so a contended
	// CI runner can't blow the budget and flip them into the estimator path.
	const WITHIN_BUDGET_TIME_LIMIT = Infinity;

	// Comfortably above MIN_ESTIMATOR_SAMPLE (1000) and more than twice it, so the halfway test can
	// fire and drop the scan into the sampling path.
	const LIVE_ROWS = 3000;

	let RecordCountTable;
	let EstimatorTable;

	const rowId = (i) => 'k-' + String(i).padStart(7, '0');

	async function buildTable(name, rows, { churnRounds = 0, churnFrom = 0, churnTo = rows } = {}) {
		const built = table({
			table: name,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		let last;
		for (let i = 0; i < rows; i++) last = built.put({ id: rowId(i), name: 'name-' + i });
		await last;
		built.primaryStore.flushSync?.();
		for (let round = 0; round < churnRounds; round++) {
			for (let i = churnFrom; i < churnTo; i++) last = built.put({ id: rowId(i), name: 'r' + round + '-' + i });
			await last;
			// each round lands in its own SST, so superseded versions accumulate uncompacted
			built.primaryStore.flushSync?.();
		}
		return built;
	}

	before(async function () {
		this.timeout(120000);
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

		EstimatorTable = await buildTable('RecordCountEstimatorTable', LIVE_ROWS);
	});

	it('returns the exact count when the loop completes within the time budget', async function () {
		const result = await RecordCountTable.getRecordCount({ timeLimit: WITHIN_BUDGET_TIME_LIMIT });
		assert.equal(result.recordCount, 30);
		assert.equal(result.estimatedRange, undefined);
	});

	it('switches to the sampling estimator when the time budget is exhausted', async function () {
		this.timeout(120000);
		// Force the early-exit branch. A negative time budget makes the budget test true on the first
		// iteration that reaches it deterministically (a 0ms budget is racy: a tiny table can finish
		// before the monotonic clock advances past the start, completing exactly instead of estimating).
		// This is the regression guard for the RocksDB entryCount bug: when `entryCount` was undefined
		// on RocksDB stores, `halfway` became NaN and `entriesScanned < halfway` was always false, so
		// the early-exit never fired and getRecordCount silently full-scanned every table. With a working
		// entryCount we drop into the sampling path once past the sample floor and return an `estimatedRange`.
		const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
		assert.ok(
			Array.isArray(result.estimatedRange),
			'expected getRecordCount to engage the sampling estimator (estimatedRange should be set)'
		);
		assert.equal(result.estimatedRange.length, 2);
	});

	it('keeps the sampling estimate within a sane factor of the true record count', async function () {
		this.timeout(120000);
		// Guards the reverse-sample bound. With a negative time budget the forward pass escapes as soon
		// as it clears the sample floor and the estimator runs. If the reverse loop is unbounded
		// (rocksdb-js ignores the getRange `limit`), it counts every live row, so `recordRate` blows up
		// and the estimate scales with entryCount^2 -- the `record_count=20,000,000`-for-~105K-rows bug.
		const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
		assert.ok(
			result.recordCount > 0 && result.recordCount <= LIVE_ROWS * 4,
			`estimate ${result.recordCount} should track the ~${LIVE_ROWS} live records, not an inflated key count`
		);
	});

	it('tracks live rows, not the inflated physical key count, when keys are repeatedly overwritten', async function () {
		this.timeout(120000);
		// The extrapolation base is an estimate now, so the guard is that it is *calibrated*: superseded
		// versions accumulating across uncompacted SSTs drive rocksdb `estimate-num-keys` well above the
		// live count, and the base must still track live rows. Needs more than MIN_ESTIMATOR_SAMPLE rows,
		// or the scan completes exactly and never exercises the estimator at all.
		const Churned = await buildTable('RecordCountUniformChurn', LIVE_ROWS, { churnRounds: 10 });
		const physicalEstimate = Churned.primaryStore.getEstimatedKeyCount?.() ?? LIVE_ROWS;
		if (physicalEstimate < LIVE_ROWS * 1.5) {
			console.warn(
				`getRecordCount inflation guard: estimate ${physicalEstimate} not meaningfully inflated vs ${LIVE_ROWS} live; assertion still valid but less discriminating`
			);
		}

		const result = await Churned.getRecordCount({ timeLimit: -1 });
		assert.ok(
			result.recordCount <= LIVE_ROWS * 1.5,
			`estimate ${result.recordCount} should track ${LIVE_ROWS} live records, not the inflated physical key count (${physicalEstimate})`
		);
	});

	it('reports a range that contains the true count when churn misses the sampled ends', async function () {
		this.timeout(120000);
		// The case a prefix-calibrated base cannot see: clean head and tail, rewritten middle. Prefix
		// density says the remainder is clean, so calibration applies no correction and `record_count`
		// over-reports. The bounded scan cannot detect this, so the contract that has to hold is the
		// range: built from the uncalibrated physical remainder, it must still contain the live count.
		const Middle = await buildTable('RecordCountMiddleChurn', LIVE_ROWS, {
			churnRounds: 30,
			churnFrom: 1000,
			churnTo: 2000,
		});
		const result = await Middle.getRecordCount({ timeLimit: -1 });
		assert.ok(Array.isArray(result.estimatedRange), 'expected the sampling estimator to engage');
		const [lower, upper] = result.estimatedRange;
		assert.ok(
			lower <= LIVE_ROWS && LIVE_ROWS <= upper,
			`estimated range [${lower}, ${upper}] must contain the ${LIVE_ROWS} live records`
		);
	});

	it('completes exactly just above the sample floor', async function () {
		this.timeout(120000);
		// Above MIN_ESTIMATOR_SAMPLE but below twice it, so every checkpoint finds the scan already past
		// the halfway point and the loop runs to an exact count. This is the guard for the checkpoint
		// contract: `CountEstimator.advance` is incremental, so reporting the cumulative scanned total at
		// each checkpoint would inflate the base until the halfway test flipped and forced a bogus estimate.
		const JustAbove = await buildTable('RecordCountJustAboveFloor', 1500);
		const result = await JustAbove.getRecordCount({ timeLimit: -1 });
		assert.equal(result.recordCount, 1500);
		assert.equal(result.estimatedRange, undefined, 'a table this size must not reach the sampling path');
	});

	it('never takes an exact key count on the estimated path', async function () {
		this.timeout(120000);
		// The whole point of the change: the escape fires because the value scan is already too slow, so
		// it must not answer with a second full scan of the same key space.
		const store = EstimatorTable.primaryStore;
		if (typeof store.getKeysCount !== 'function') return this.skip();
		const original = store.getKeysCount;
		const owned = Object.hasOwn(store, 'getKeysCount');
		let calls = 0;
		store.getKeysCount = function (...args) {
			calls++;
			return original.apply(this, args);
		};
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(Array.isArray(result.estimatedRange), 'expected the sampling estimator to engage');
			assert.equal(calls, 0, 'the estimated path must not call getKeysCount');
		} finally {
			if (owned) store.getKeysCount = original;
			else delete store.getKeysCount;
		}
	});

	it('returns a valid record count and range for a tiny table under an exhausted budget', async function () {
		// Edge case: a 1-row table with a negative (always-exhausted) budget. `halfway` is 0, so the
		// early-exit can't fire (entriesScanned is never < 0) and the loop completes to an exact count
		// rather than estimating from a sample that would otherwise overlap its own tail. Guards against
		// an inverted/invalid range.
		const TinyTable = table({
			table: 'RecordCountTinyTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		await TinyTable.put({ id: 'solo', name: 'only-row' });

		const result = await TinyTable.getRecordCount({ timeLimit: -1 });
		const [lower, upper] = result.estimatedRange ?? [result.recordCount, result.recordCount];
		assert.ok(lower <= upper, `estimated range must be valid (got [${lower}, ${upper}])`);
		assert.ok(
			result.recordCount >= 1 && result.recordCount <= 10,
			`estimate ${result.recordCount} should track the single live row`
		);
	});

	it('does not take a key count when the scan completes within the time budget', async function () {
		// The entry-count source should only be consulted when the value scan blows the time budget;
		// a within-budget scan returns the exact count directly and must not pay for it. The source is
		// engine-dependent -- getKeysCount() (a full key scan) on RocksDB, getStats().entryCount on LMDB
		// (the resources suite runs under both) -- so spy on whichever the store exposes.
		// `primaryStore` is shared and the scan yields once per entry, so an absolute call count is not a
		// count of what this call did: the analytics aggregation timer sweeps every table's getStats()
		// every half aggregate period (storeRocksDBStatsMetrics, or Table.getSize via
		// storeTableSizeMetrics under LMDB) and lands inside the window at random.
		const store = RecordCountTable.primaryStore;
		const underTest = new AsyncLocalStorage();
		let calls = 0;
		let foreignCalls = 0;
		const restore = [];
		for (const name of ['getKeysCount', 'getStats']) {
			if (typeof store[name] !== 'function') continue;
			const original = store[name];
			const owned = Object.hasOwn(store, name);
			store[name] = function (...args) {
				if (underTest.getStore()) calls++;
				else foreignCalls++;
				return original.apply(this, args);
			};
			restore.push(() => {
				if (owned) store[name] = original;
				else delete store[name];
			});
		}
		try {
			// Positive control for the attribution, in the shape of the analytics sweep: queued before the
			// scan's first `await rest()`, so it runs while the scan is suspended. Contained and reported
			// here rather than left to escape the immediate, which would abort the run.
			let foreignError;
			setImmediate(() => {
				try {
					store.getStats();
				} catch (error) {
					foreignError = error;
				}
			});
			const completed = await underTest.run(true, () =>
				RecordCountTable.getRecordCount({ timeLimit: WITHIN_BUDGET_TIME_LIMIT })
			);
			assert.equal(foreignError, undefined, 'the interleaved foreign call must not throw');
			assert.equal(completed.recordCount, 30);
			assert.equal(completed.estimatedRange, undefined);
			assert.ok(foreignCalls >= 1, 'the interleaved foreign call must reach the spy, or it proves nothing');
			assert.equal(calls, 0, 'entry-count source should not be consulted when the scan finishes within budget');

			calls = 0;
			// Below the sample floor the budget no longer matters: the scan runs to an exact count and
			// still consults nothing, which is what keeps a small churned table off an estimated base.
			const belowFloor = await underTest.run(true, () => RecordCountTable.getRecordCount({ timeLimit: -1 }));
			assert.equal(belowFloor.recordCount, 30);
			assert.equal(belowFloor.estimatedRange, undefined);
			assert.equal(calls, 0, 'a table below the sample floor must not consult the entry-count source');
		} finally {
			for (const undo of restore) undo();
		}
	});
});
