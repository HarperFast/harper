require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Pins `Table.getRecordCount()`'s CALLER-visible contract (return shape, the sampling floor, the
// `exactCount` escape, and the `describe_table` pass-through) -- as distinct from
// `getRecordCount.test.js`, which pins the estimator's internal mechanics.
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
		// Comfortably below MIN_ESTIMATOR_SAMPLE, so this discriminates the floor itself, not a 1-row edge.
		BelowFloorTable = await buildTable('RecordCountImpactBelowFloor', 900);
		EstimatorTable = await buildTable('RecordCountImpactEstimator', LIVE_ROWS);
	});

	it('a bare `Table.getRecordCount()` call (no options object at all) returns an exact count on a small table', async () => {
		const result = await SmallTable.getRecordCount();
		assert.equal(result.recordCount, 25);
		assert.equal(result.estimatedRange, undefined);
	});

	it('a table below the sampling floor stays exact even when the time budget is already exhausted', async () => {
		const result = await BelowFloorTable.getRecordCount({ timeLimit: -1 });
		assert.equal(result.recordCount, 900);
		assert.equal(result.estimatedRange, undefined, 'a table below the floor must never report an estimate');
	});

	it('`exactCount: true` forces an exact count above the floor, even with an exhausted time budget', async () => {
		const result = await EstimatorTable.getRecordCount({ timeLimit: -1, exactCount: true });
		assert.equal(result.recordCount, LIVE_ROWS);
		assert.equal(result.estimatedRange, undefined);
	});

	// Both of the next two force the native estimator's answers rather than relying on a churn
	// pattern that happens to produce a given outcome: one case where the base overshoots and the
	// range brackets the truth, one where it undershoots and does not.

	it('a caller that treats recordCount as exact can be far off, even when estimatedRange brackets the truth', async function () {
		this.timeout(120000);
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip(); // LMDB has no estimator path
		const originalEstimator = store.createCountEstimator;
		const originalCount = store.estimateCount;
		const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
		const ownedCount = Object.hasOwn(store, 'estimateCount');
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
				`expected the forced base to pull recordCount (${result.recordCount}) well above the ${LIVE_ROWS} live rows`
			);
			assert.ok(lower <= LIVE_ROWS && LIVE_ROWS <= upper, `[${lower}, ${upper}] happens to bracket ${LIVE_ROWS} here`);
			// A page-count UI built on the point estimate alone disagrees with the true page count here.
			const pageSize = 100;
			assert.notEqual(Math.ceil(result.recordCount / pageSize), Math.ceil(LIVE_ROWS / pageSize));
		} finally {
			if (ownedEstimator) store.createCountEstimator = originalEstimator;
			else delete store.createCountEstimator;
			if (ownedCount) store.estimateCount = originalCount;
			else delete store.estimateCount;
		}
	});

	it('estimatedRange is a heuristic, not a guarantee -- it can also fail to contain the live count', async function () {
		this.timeout(120000);
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip(); // LMDB has no estimator path
		const originalEstimator = store.createCountEstimator;
		const originalCount = store.estimateCount;
		const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
		const ownedCount = Object.hasOwn(store, 'estimateCount');
		// An underestimated base: the table truly has LIVE_ROWS (3000) rows, but both estimates
		// confidently claim fewer than half that.
		store.createCountEstimator = () => ({ advance() {}, estimate: () => ({ count: 2100, confidence: 0.9 }) });
		store.estimateCount = () => ({ count: 1000, confidence: 0.9 });
		try {
			const result = await EstimatorTable.getRecordCount({ timeLimit: -1 });
			assert.ok(Array.isArray(result.estimatedRange), 'expected the sampling estimator to engage');
			const [, upper] = result.estimatedRange;
			assert.ok(
				upper < LIVE_ROWS,
				`expected the underestimated base to produce an upper bound (${upper}) below the ${LIVE_ROWS} live rows`
			);
		} finally {
			if (ownedEstimator) store.createCountEstimator = originalEstimator;
			else delete store.createCountEstimator;
			if (ownedCount) store.estimateCount = originalCount;
			else delete store.estimateCount;
		}
	});

	it('describe_table reports record_count/estimated_record_range from getRecordCount, and forwards exact_count as exactCount', async () => {
		// A 3,000-row scan finishes well inside the default 500ms budget on its own, so the default
		// call being exact proves nothing about whether exact_count is actually forwarded. Spying on
		// the options getRecordCount receives isolates that specific claim.
		const original = EstimatorTable.getRecordCount;
		const receivedOptions = [];
		EstimatorTable.getRecordCount = function (options) {
			receivedOptions.push(options);
			return original.call(this, options);
		};
		try {
			const exact = await describeTable({ database: 'test', table: 'RecordCountImpactEstimator' });
			assert.equal(receivedOptions[0]?.exactCount, false);
			assert.equal(exact.record_count, LIVE_ROWS);

			const forcedExact = await describeTable({
				database: 'test',
				table: 'RecordCountImpactEstimator',
				exact_count: true,
			});
			assert.equal(receivedOptions[1]?.exactCount, true);
			assert.equal(forcedExact.record_count, LIVE_ROWS);
			assert.equal(forcedExact.estimated_record_range, undefined);
		} finally {
			EstimatorTable.getRecordCount = original;
		}
	});

	it('describe_table also passes through an estimated_record_range when getRecordCount returns one', async () => {
		// describe_table exposes no timeLimit knob, and a 3,000-row scan easily finishes inside the
		// default budget -- so landing this deterministically on the sampling path means not relying
		// on real scan timing at all. Stubbing getRecordCount itself isolates exactly the claim this
		// test makes: that schemaDescribe.ts's pass-through forwards estimatedRange, not just
		// recordCount, whatever getRecordCount actually returns.
		const original = EstimatorTable.getRecordCount;
		EstimatorTable.getRecordCount = async () => ({ recordCount: 12345, estimatedRange: [10000, 20000] });
		try {
			const result = await describeTable({ database: 'test', table: 'RecordCountImpactEstimator' });
			assert.equal(result.record_count, 12345);
			assert.deepEqual(result.estimated_record_range, [10000, 20000]);
		} finally {
			EstimatorTable.getRecordCount = original;
		}
	});

	it('describe_table with skip_record_count never calls getRecordCount, so the field is simply absent', async () => {
		// Spying on getRecordCount itself (rather than the store methods it may call) keeps this
		// independent of which engine-specific stats source getSize()/getAuditSize() legitimately
		// call on their own.
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
