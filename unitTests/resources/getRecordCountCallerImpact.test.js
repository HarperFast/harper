require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { describeTable } = require('#src/dataLayer/schemaDescribe');
const { setMainIsWorker, getWorkerIndex } = require('#js/server/threads/manageThreads');

describe('Table.getRecordCount caller impact', () => {
	const LIVE_ROWS = 3000;

	const rowId = (i) => 'k-' + String(i).padStart(7, '0');

	async function buildTable(name, rows) {
		const built = table({
			table: name,
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const puts = [];
		for (let i = 0; i < rows; i++) puts.push(built.put({ id: rowId(i), name: 'name-' + i }));
		await Promise.all(puts);
		built.primaryStore.flushSync?.();
		return built;
	}

	let SmallTable;
	let BelowFloorTable;
	let EstimatorTable;
	let originalWasWorker;

	before(async function () {
		this.timeout(120000);
		originalWasWorker = getWorkerIndex() !== undefined;
		setupTestDBPath();
		setMainIsWorker(true);
		SmallTable = await buildTable('RecordCountImpactSmall', 25);
		BelowFloorTable = await buildTable('RecordCountImpactBelowFloor', 900);
		EstimatorTable = await buildTable('RecordCountImpactEstimator', LIVE_ROWS);
	});

	after(() => {
		setMainIsWorker(originalWasWorker);
	});

	it('a bare `Table.getRecordCount()` call (no options object at all) returns an exact count on a small table', async () => {
		const result = await SmallTable.getRecordCount();
		assert.equal(result.recordCount, 25);
		assert.strictEqual(result.estimatedRange, undefined);
	});

	it('a table below the sampling floor stays exact even when the time budget is already exhausted', async () => {
		const result = await BelowFloorTable.getRecordCount({ timeLimit: -1 });
		assert.equal(result.recordCount, 900);
		assert.strictEqual(result.estimatedRange, undefined, 'a table below the floor must never report an estimate');
	});

	it('`exactCount: true` forces an exact count above the floor, even with an exhausted time budget', async () => {
		const result = await EstimatorTable.getRecordCount({ timeLimit: -1, exactCount: true });
		assert.equal(result.recordCount, LIVE_ROWS);
		assert.strictEqual(result.estimatedRange, undefined);
	});

	it('a caller that treats recordCount as exact can be far off, even when estimatedRange brackets the truth', async function () {
		this.timeout(120000);
		const store = EstimatorTable.primaryStore;
		if (typeof store.createCountEstimator !== 'function') return this.skip(); // LMDB's base comes from getStats(), not this seam
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
		if (typeof store.createCountEstimator !== 'function') return this.skip(); // LMDB's base comes from getStats(), not this seam
		const originalEstimator = store.createCountEstimator;
		const originalCount = store.estimateCount;
		const ownedEstimator = Object.hasOwn(store, 'createCountEstimator');
		const ownedCount = Object.hasOwn(store, 'estimateCount');
		// A base of 2,100 keeps the 1,000-entry sample below halfway while leaving enough unsampled
		// rows for the heuristic upper bound to undershoot the true count.
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
		const original = EstimatorTable.getRecordCount;
		const receivedOptions = [];
		EstimatorTable.getRecordCount = function (options) {
			receivedOptions.push(options);
			return original.call(this, { ...options, timeLimit: Infinity }); // scan time must not decide this assertion
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
			assert.strictEqual(forcedExact.estimated_record_range, undefined);
		} finally {
			EstimatorTable.getRecordCount = original;
		}
	});

	it('describe_table also passes through an estimated_record_range when getRecordCount returns one', async () => {
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
