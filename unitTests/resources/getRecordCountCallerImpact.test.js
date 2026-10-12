require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// `Table.getRecordCount()`'s shape -- `{ recordCount: number, estimatedRange?: [number, number] }` --
// and its decision to estimate rather than scan exactly have not changed recently: the estimator-based
// escape (sampling + a confidence-interval range instead of scanning to completion) dates to 30f4df609
// (2023-10-19), and the specific internal data source that feeds that escape on RocksDB -- an exact
// `getKeysCount()` scan versus a cheap `createCountEstimator`/`estimateCount` sample -- was swapped by
// 921a635c2 ("Size describe record counts with a calibrated estimate instead of a second full key scan",
// 2026-09-14, merged to the v5.3.x line) and independently by #2612/f96c27488 on the v5.2.x line the next
// day; both land on the code this suite exercises, and v5.2.15, v5.3.0 and main are byte-identical here.
// `unitTests/resources/getRecordCount.test.js` pins that estimator's internal mechanics (checkpointing,
// fallbacks, range validity). This file pins the CALLER-visible contract instead: what a piece of
// application code built against `getRecordCount()` -- directly, through `describe_table`, or through
// pagination/equality logic layered on top of the returned count -- actually observes.
describe('Table.getRecordCount caller impact', () => {
	const LIVE_ROWS = 3000;

	const rowId = (i) => 'k-' + String(i).padStart(7, '0');

	async function buildTable(name, rows) {
		const built = table({
			table: name,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		let last;
		for (let i = 0; i < rows; i++) last = built.put({ id: rowId(i), name: 'name-' + i });
		await last;
		built.primaryStore.flushSync?.();
		return built;
	}

	let SmallTable;
	let BelowFloorTable;
	let EstimatorTable;

	before(async function () {
		this.timeout(120000);
		setupTestDBPath();
		setMainIsWorker(true);
		SmallTable = await buildTable('RecordCountImpactSmall', 25);
		// Below MIN_ESTIMATOR_SAMPLE by a comfortable margin, so a scan that clears the floor with room to
		// spare (not just a 1-row edge case) still has to finish exactly.
		BelowFloorTable = await buildTable('RecordCountImpactBelowFloor', 900);
		EstimatorTable = await buildTable('RecordCountImpactEstimator', LIVE_ROWS);
	});

	it('a bare `Table.getRecordCount()` call (no options object at all) returns an exact count on a small table', async () => {
		// The common shape in application code: no options, defaults apply. `options?.exactCount` and
		// `options?.timeLimit ?? 500` must both tolerate `options` being `undefined`, not just `{}`.
		const result = await SmallTable.getRecordCount();
		assert.equal(result.recordCount, 25);
		assert.equal(result.estimatedRange, undefined);
	});

	it('a table below the sampling floor stays exact even when the time budget is already exhausted', async () => {
		// Answers the rule's "is the estimate exact below some size?" question directly, with enough
		// margin above the 1-row edge case that it discriminates the floor itself, not just the edge.
		const result = await BelowFloorTable.getRecordCount({ timeLimit: -1 });
		assert.equal(result.recordCount, 900);
		assert.equal(result.estimatedRange, undefined, 'a table below the floor must never report an estimate');
	});

	it('`exactCount: true` forces an exact count above the floor, even with an exhausted time budget', async () => {
		// The one caller-controlled escape hatch from estimation entirely: `options.exactCount` short-
		// circuits the budget check unconditionally (`if (exactCount || entriesScanned < MIN_ESTIMATOR_SAMPLE)
		// continue`), so it is unaffected by anything that changes how the *estimate* is computed.
		const result = await EstimatorTable.getRecordCount({ timeLimit: -1, exactCount: true });
		assert.equal(result.recordCount, LIVE_ROWS);
		assert.equal(result.estimatedRange, undefined);
	});

	it(
		'a caller that treats the sampled recordCount as exact can be far off, though estimatedRange still ' +
			'brackets the live count -- which is the actual contract',
		async function () {
			this.timeout(120000);
			// This is the caller hazard behind "counts compared for equality in tests or business logic" and
			// "counts used for pagination math": the single published number is a rounded point estimate, not
			// a bound. Only the pair [lower, upper] is guaranteed to contain the true count. Forcing a
			// confidently wrong base (rather than waiting for a churn pattern that happens to produce one)
			// makes the divergence deterministic instead of a matter of luck.
			const store = EstimatorTable.primaryStore;
			if (typeof store.createCountEstimator !== 'function') return this.skip(); // LMDB has no estimator path
			const originalEstimator = store.createCountEstimator;
			const originalCount = store.estimateCount;
			const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
			const ownedCount = Object.hasOwn(store, 'estimateCount');
			// A confidently wrong base: the table truly has LIVE_ROWS (3000) rows, but the (feature-detected)
			// estimator insists there are 10x that, with high confidence on both the prefix and the remainder.
			store.createCountEstimator = () => ({
				advance() {},
				estimate: () => ({ count: LIVE_ROWS * 10, confidence: 0.9 }),
			});
			store.estimateCount = () => ({ count: LIVE_ROWS * 9, confidence: 0.9 });
			try {
				const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
				assert.ok(Array.isArray(result.estimatedRange), 'expected the sampling estimator to engage');
				const [lower, upper] = result.estimatedRange;
				assert.ok(
					result.recordCount > LIVE_ROWS * 2,
					`expected the forced-wrong base to pull recordCount (${result.recordCount}) well above the ` +
						`${LIVE_ROWS} live rows -- demonstrating the point estimate is not authoritative`
				);
				assert.ok(
					lower <= LIVE_ROWS && LIVE_ROWS <= upper,
					`the live count (${LIVE_ROWS}) must still fall inside [${lower}, ${upper}] -- that containment, ` +
						`not the point estimate, is the documented guarantee`
				);
				// Pagination math built on the point estimate: `Math.ceil(recordCount / pageSize)` can disagree
				// with the true page count, but the SAME computation over [lower, upper] still brackets it.
				const pageSize = 100;
				const pagesFromEstimate = Math.ceil(result.recordCount / pageSize);
				const truePages = Math.ceil(LIVE_ROWS / pageSize);
				assert.notEqual(
					pagesFromEstimate,
					truePages,
					'expected the forced-wrong estimate to also mislead a naive total-pages calculation'
				);
				const pagesFromLower = Math.ceil(lower / pageSize);
				const pagesFromUpper = Math.ceil(upper / pageSize);
				assert.ok(
					pagesFromLower <= truePages && truePages <= pagesFromUpper,
					`the true page count (${truePages}) must still lie within [${pagesFromLower}, ${pagesFromUpper}] ` +
						`derived from estimatedRange, even though recordCount alone (${pagesFromEstimate} pages) does not`
				);
			} finally {
				if (ownedEstimator) store.createCountEstimator = originalEstimator;
				else delete store.createCountEstimator;
				if (ownedCount) store.estimateCount = originalCount;
				else delete store.estimateCount;
			}
		}
	);

	it('describe_table reports record_count/estimated_record_range from getRecordCount, and honors exact_count', async () => {
		// The `describe_table`/`describe_all` operations surface (dataLayer/schemaDescribe.ts) is a thin
		// pass-through: `record_count`/`estimated_record_range` are exactly `getRecordCount()`'s
		// `recordCount`/`estimatedRange`, and `exact_count` maps straight to `options.exactCount`.
		const exact = await describeTable({ database: 'test', table: 'RecordCountImpactSmall' });
		assert.equal(exact.record_count, 25);
		assert.equal(exact.estimated_record_range, undefined);

		const forcedExactOnLarge = await describeTable({
			database: 'test',
			table: 'RecordCountImpactEstimator',
			exact_count: true,
		});
		assert.equal(forcedExactOnLarge.record_count, LIVE_ROWS);
		assert.equal(forcedExactOnLarge.estimated_record_range, undefined);
	});

	it('describe_table with skip_record_count never calls getRecordCount, so the field is simply absent', async () => {
		// A caller asking only for schema/metadata (`skip_record_count: true`) must not pay for the scan at
		// all, and the field it would have populated must not appear -- not `null`, not `0`, absent. Spying
		// on getRecordCount itself (rather than the store methods it may call) keeps this independent of
		// which engine-specific stats source `getSize()`/`getAuditSize()` legitimately call on their own.
		const original = EstimatorTable.getRecordCount;
		let calls = 0;
		EstimatorTable.getRecordCount = function (...args) {
			calls++;
			return original.apply(this, args);
		};
		try {
			const result = await describeTable({
				database: 'test',
				table: 'RecordCountImpactEstimator',
				skip_record_count: true,
			});
			assert.equal(Object.hasOwn(result, 'record_count'), false);
			assert.equal(Object.hasOwn(result, 'estimated_record_range'), false);
			assert.equal(calls, 0, 'skip_record_count must not call getRecordCount at all');
		} finally {
			EstimatorTable.getRecordCount = original;
		}
	});
});
