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
	// mirrors MIN_ESTIMATOR_SAMPLE in resources/Table.ts
	const MIN_ESTIMATOR_SAMPLE = 1000;
	// Each churn round is a write pass plus a flushSync, which is what puts superseded versions in
	// their own SST. Five saturates rocksdb's inflated `estimate-num-keys` (measured: the physical
	// estimate stops climbing well before this), and the suite's CI step has under a minute of slack.
	const CHURN_ROUNDS = 5;

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
		const Churned = await buildTable('RecordCountUniformChurn', LIVE_ROWS, { churnRounds: CHURN_ROUNDS });
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
			churnRounds: CHURN_ROUNDS,
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
		// Above MIN_ESTIMATOR_SAMPLE but below twice it, so no checkpoint finds the scan below halfway and
		// the count comes back exact -- either from the loop completing or from the two samples meeting.
		const JustAbove = await buildTable('RecordCountJustAboveFloor', 1500);
		const result = await JustAbove.getRecordCount({ timeLimit: -1 });
		assert.equal(result.recordCount, 1500);
		assert.equal(result.estimatedRange, undefined, 'a table this size must not reach the sampling path');
	});

	it('reports checkpoint deltas, not the cumulative scanned total', async function () {
		this.timeout(120000);
		// `CountEstimator.advance` is incremental. Reporting the running total at each checkpoint compounds
		// it quadratically -- twenty checkpoints past the floor would claim over 20,000 entries traversed on
		// a 3,000-row table -- taking the base, the halfway decision and the extrapolation with it. Asserting
		// on the reported total is what discriminates this; the returned count alone does not, because the
		// two samples meet and report exactly either way. The fixture has to be a table the halfway test
		// never releases, so checkpoints accumulate -- on a table that escapes at the first checkpoint there
		// is only one advance() and the two contracts are indistinguishable.
		const Accumulating = await buildTable('RecordCountCheckpointDeltas', 1500);
		const store = Accumulating.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const original = store.createCountEstimator;
		const owned = Object.hasOwn(store, 'createCountEstimator');
		let advanced = 0;
		store.createCountEstimator = function (...args) {
			const estimator = original.apply(this, args);
			return {
				advance(lastKey, count) {
					advanced += count;
					return estimator.advance(lastKey, count);
				},
				estimate: () => estimator.estimate(),
			};
		};
		try {
			await Accumulating.getRecordCount({ timeLimit: -1 });
			assert.ok(advanced > 0, 'the estimator must have been checkpointed at all');
			assert.ok(advanced <= 1500, `reported ${advanced} entries traversed, more than the 1500 the table holds`);
		} finally {
			if (owned) store.createCountEstimator = original;
			else delete store.createCountEstimator;
		}
	});

	it('keeps the reported count inside its own range across churn distributions', async function () {
		this.timeout(300000);
		// `record_count` and `estimated_record_range` are published side by side, so a count outside its own
		// interval is self-contradictory whatever the base did. Head-concentrated churn is the case that
		// produces it: the inflated prefix calibrates the base *below* what the two samples already counted.
		const shapes = [
			['RecordCountHeadChurn', { churnRounds: CHURN_ROUNDS, churnFrom: 0, churnTo: 1000 }],
			['RecordCountTailChurn', { churnRounds: CHURN_ROUNDS, churnFrom: 2000, churnTo: 3000 }],
		];
		for (const [name, shape] of shapes) {
			const built = await buildTable(name, LIVE_ROWS, shape);
			const result = await built.getRecordCount({ timeLimit: -1 });
			const [lower, upper] = result.estimatedRange ?? [result.recordCount, result.recordCount];
			assert.ok(lower <= upper, `${name}: range [${lower}, ${upper}] must not be inverted`);
			assert.ok(
				lower <= result.recordCount && result.recordCount <= upper,
				`${name}: reported count ${result.recordCount} must lie within its own range [${lower}, ${upper}]`
			);
			assert.ok(
				lower <= LIVE_ROWS && LIVE_ROWS <= upper,
				`${name}: range [${lower}, ${upper}] must contain the ${LIVE_ROWS} live records`
			);
		}
	});

	it('does not collapse the range when both sampled ends are deletion entries', async function () {
		this.timeout(120000);
		// Deleted records stay in the range as null-valued entries, so a table trimmed at both ends -- an
		// ordinary shape for a time-keyed table with old rows removed -- can present the sampler with two
		// all-deleted samples and a live middle. The sampled rate is then 0, and an upper end derived from
		// that rate collapses to near zero while thousands of live rows sit between the samples.
		const Trimmed = table({
			table: 'RecordCountTrimmedEnds',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const TOTAL = 3600;
		const LIVE = 1200;
		let last;
		for (let i = 0; i < TOTAL; i++) last = Trimmed.put({ id: rowId(i), name: 'name-' + i });
		await last;
		for (let i = 0; i < 1200; i++) last = Trimmed.delete(rowId(i));
		for (let i = 2400; i < TOTAL; i++) last = Trimmed.delete(rowId(i));
		await last;
		Trimmed.primaryStore.flushSync?.();

		// Counted per end, not table-wide: the sampler reads a run from each end, so a table-wide total
		// can clear the floor on head entries alone while the reverse sample is entirely live -- which is a
		// rate of 0.5, not the rate-0 case this test exists for.
		let leadingNulls = 0;
		let trailingNulls = 0;
		for (const { value } of Trimmed.primaryStore.getRange({ start: true, lazy: true, snapshot: false })) {
			if (value != null) break;
			leadingNulls++;
		}
		for (const { value } of Trimmed.primaryStore.getRange({
			start: '\uffff',
			reverse: true,
			lazy: true,
			snapshot: false,
		})) {
			if (value != null) break;
			trailingNulls++;
		}
		if (leadingNulls < MIN_ESTIMATOR_SAMPLE || trailingNulls < MIN_ESTIMATOR_SAMPLE) {
			// the engine reclaimed the deletion entries, so the sampler never sees an all-deleted end
			return this.skip();
		}

		const result = await Trimmed.getRecordCount({ timeLimit: -1 });
		const [lower, upper] = result.estimatedRange ?? [result.recordCount, result.recordCount];
		assert.ok(
			lower <= LIVE && LIVE <= upper,
			`range [${lower}, ${upper}] must contain the ${LIVE} live records between the deleted ends`
		);
	});

	it('does not round the estimate away when the physical base dwarfs it', async function () {
		this.timeout(120000);
		// The reported precision is derived from the interval, whose upper end is the *physical* base --
		// on a churn-heavy table that exceeds the *calibrated* estimate by orders of magnitude. A single
		// corrective division cannot walk a unit that large back below the estimate, so the estimate
		// rounds to zero and is published as the interval's lower end instead.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const originalEstimator = store.createCountEstimator;
		const originalCount = store.estimateCount;
		const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
		const ownedCount = Object.hasOwn(store, 'estimateCount');
		store.createCountEstimator = () => ({
			advance() {},
			estimate: () => ({ count: LIVE_ROWS, confidence: 0.5 }),
		});
		store.estimateCount = () => ({ count: 9_900_000, confidence: 0.5 });
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(
				result.recordCount >= LIVE_ROWS * 0.9,
				`reported ${result.recordCount} for ~${LIVE_ROWS} live records; the estimate was rounded away by a unit taken from the physical base`
			);
		} finally {
			if (ownedEstimator) store.createCountEstimator = originalEstimator;
			else delete store.createCountEstimator;
			if (ownedCount) store.estimateCount = originalCount;
			else delete store.estimateCount;
		}
	});

	it('falls back to the whole-store estimate when range estimates report zero', async function () {
		this.timeout(120000);
		// Range estimates are block-granular and can legitimately report 0 for present keys -- a store whose
		// entries are still in the memtable. With no base the escape cannot fire at all, so this must reach
		// the whole-store property rather than silently walking the table.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const originalEstimator = store.createCountEstimator;
		const originalWhole = store.getEstimatedKeyCount;
		const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
		const ownedWhole = Object.hasOwn(store, 'getEstimatedKeyCount');
		let wholeStoreCalls = 0;
		store.createCountEstimator = () => ({
			advance() {},
			estimate: () => ({ count: 0, confidence: 0 }),
		});
		store.getEstimatedKeyCount = function (...args) {
			wholeStoreCalls++;
			return originalWhole.apply(this, args);
		};
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(wholeStoreCalls > 0, 'a zero range estimate must fall back to the whole-store key count');
			assert.ok(
				Array.isArray(result.estimatedRange),
				'with a usable whole-store base the escape should fire rather than scanning the whole table'
			);
		} finally {
			if (ownedEstimator) store.createCountEstimator = originalEstimator;
			else delete store.createCountEstimator;
			if (ownedWhole) store.getEstimatedKeyCount = originalWhole;
			else delete store.getEstimatedKeyCount;
		}
	});

	it('rejects an estimate whose confidence is not a number', async function () {
		this.timeout(120000);
		// `null >= 0 && null <= 1` is true, so a range check alone accepts `confidence: null` and lets an
		// unvalidated count become the extrapolation base. Mirrors the contract check at
		// `resources/search.ts:1280` for the same estimate shape.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const original = store.createCountEstimator;
		const owned = Object.hasOwn(store, 'createCountEstimator');
		store.createCountEstimator = () => ({
			advance() {},
			estimate: () => ({ count: LIVE_ROWS * 10, confidence: null }),
		});
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(
				result.recordCount <= LIVE_ROWS * 2,
				`reported ${result.recordCount} for ~${LIVE_ROWS} live records; a confidence of null was accepted as a valid estimate`
			);
		} finally {
			if (owned) store.createCountEstimator = original;
			else delete store.createCountEstimator;
		}
	});

	it('does not collapse the range when the remainder estimate reports zero', async function () {
		this.timeout(120000);
		// A zero remainder is valid -- entries still in the memtable read as none through range statistics.
		// If the prefix estimator returned any positive underestimate the whole-store fallback above is
		// skipped, so a zero remainder would leave `baseMax` resting on the sampled ends alone and publish a
		// range that excludes the live rows between them.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const originalEstimator = store.createCountEstimator;
		const originalCount = store.estimateCount;
		const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
		const ownedCount = Object.hasOwn(store, 'estimateCount');
		// a positive underestimate: enough for the halfway test to fire, well under the true row count
		store.createCountEstimator = () => ({ advance() {}, estimate: () => ({ count: 2100, confidence: 0.5 }) });
		store.estimateCount = () => ({ count: 0, confidence: 1 });
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			const [lower, upper] = result.estimatedRange ?? [result.recordCount, result.recordCount];
			assert.ok(
				lower <= LIVE_ROWS && LIVE_ROWS <= upper,
				`range [${lower}, ${upper}] must contain the ${LIVE_ROWS} live records despite a zero remainder estimate`
			);
		} finally {
			if (ownedEstimator) store.createCountEstimator = originalEstimator;
			else delete store.createCountEstimator;
			if (ownedCount) store.estimateCount = originalCount;
			else delete store.estimateCount;
		}
	});

	it('caps the reverse sample independently of the forward scan', async function () {
		this.timeout(120000);
		// `limit` is whatever the forward pass covered before escaping, and the checkpoint ceiling lets that
		// run twenty budget intervals when the base undershoots. Sizing the tail sample to match would read
		// that count a second time and double the call's wall clock.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const original = store.createCountEstimator;
		const owned = Object.hasOwn(store, 'createCountEstimator');
		// never releases the halfway test, so the forward scan runs to the checkpoint ceiling
		let traversed = 0;
		store.createCountEstimator = () => ({
			advance(lastKey, count) {
				traversed += count;
			},
			estimate: () => ({ count: traversed, confidence: 0.5 }),
		});
		const originalGetRange = store.getRange;
		let reverseRequested;
		store.getRange = function (options) {
			if (options?.reverse) reverseRequested = options.limit;
			return originalGetRange.call(this, options);
		};
		try {
			await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(
				reverseRequested != null && reverseRequested <= MIN_ESTIMATOR_SAMPLE,
				`reverse sample requested ${reverseRequested} entries; it must stay capped at ${MIN_ESTIMATOR_SAMPLE} regardless of how far the forward scan ran`
			);
		} finally {
			if (owned) store.createCountEstimator = original;
			else delete store.createCountEstimator;
			store.getRange = originalGetRange;
		}
	});

	it('stops scanning when the base keeps saying the scan is past halfway', async function () {
		this.timeout(120000);
		// A base that undershoots holds `entriesScanned < floor(entryCount/2)` false at every checkpoint, so
		// the escape never fires and describe walks the whole table -- the unbounded scan this path exists to
		// avoid, reached through a working estimator rather than the old NaN `halfway`. The checkpoint ceiling
		// is what bounds it; without one this returns an exact count because the scan ran to the end.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const original = store.createCountEstimator;
		const owned = Object.hasOwn(store, 'createCountEstimator');
		let traversed = 0;
		store.createCountEstimator = () => ({
			advance(lastKey, count) {
				traversed += count;
			},
			// always reports the scan as having reached the end, so the halfway test can never fire
			estimate: () => ({ count: traversed, confidence: 0.5 }),
		});
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(
				Array.isArray(result.estimatedRange),
				'expected the checkpoint ceiling to force the sampling path rather than scanning the whole table'
			);
			assert.ok(traversed < LIVE_ROWS, `scan should have stopped early, but traversed ${traversed} of ${LIVE_ROWS}`);
		} finally {
			if (owned) store.createCountEstimator = original;
			else delete store.createCountEstimator;
		}
	});

	it('falls back to an exact count when the estimator is unusable', async function () {
		this.timeout(120000);
		// DESIGN.md's invariant for this API: a store that answers differently, or one closing concurrently,
		// degrades to the historical behavior instead of NaN-poisoning the count.
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip();
		const original = store.createCountEstimator;
		const owned = Object.hasOwn(store, 'createCountEstimator');
		store.createCountEstimator = () => {
			throw new Error('native estimator unavailable');
		};
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.equal(result.recordCount, LIVE_ROWS);
			assert.equal(result.estimatedRange, undefined);
		} finally {
			if (owned) store.createCountEstimator = original;
			else delete store.createCountEstimator;
		}
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
