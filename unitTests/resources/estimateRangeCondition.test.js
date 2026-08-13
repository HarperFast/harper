require('../testUtils');
const assert = require('node:assert');
const { estimateCondition } = require('#src/resources/search');
const { MAXIMUM_KEY } = require('ordered-binary');

// Range comparators historically estimated as fixed fractions of the table
// (0.05 starts_with / 0.1 between / 0.3 open range). When the store provides
// rocksdb-js estimateCount, the planner now uses the statistical range
// estimate, blended with the fraction heuristic by the estimate's confidence.
// These tests drive estimateCondition with synthetic stores so the dispatch,
// range construction, and blend are covered regardless of the installed
// rocksdb-js version (the capability is feature-detected).

const ENTRY_COUNT = 1000;

function makeStore(estimate) {
	return {
		calls: [],
		getStats: () => ({ entryCount: ENTRY_COUNT }),
		estimateCount(range) {
			this.calls.push(range);
			return estimate;
		},
	};
}

function makeTable({ indexEstimate, primaryEstimate } = {}) {
	const primaryStore = {
		getStats: () => ({ entryCount: ENTRY_COUNT }),
	};
	if (primaryEstimate) {
		primaryStore.calls = [];
		primaryStore.estimateCount = function (range) {
			this.calls.push(range);
			return primaryEstimate;
		};
	}
	const index =
		indexEstimate === undefined ? { getStats: () => ({ entryCount: ENTRY_COUNT }) } : makeStore(indexEstimate);
	return {
		primaryKey: 'id',
		primaryStore,
		indices: { attr: index },
		attributes: [],
	};
}

function estimate(table, condition) {
	return estimateCondition(table)(condition);
}

describe('estimateCondition range estimates', () => {
	it('uses the statistical estimate outright at confidence 1', () => {
		const table = makeTable({ indexEstimate: { count: 120, confidence: 1 } });
		const estimated = estimate(table, { attribute: 'attr', comparator: 'between', value: [5, 10] });
		assert.strictEqual(estimated, 120);
		assert.deepStrictEqual(table.indices.attr.calls[0], {
			start: 5,
			end: 10,
			inclusiveEnd: true,
			exclusiveStart: false,
		});
	});

	it('falls back to the fraction heuristic at confidence 0', () => {
		const table = makeTable({ indexEstimate: { count: 120, confidence: 0 } });
		const estimated = estimate(table, { attribute: 'attr', comparator: 'between', value: [5, 10] });
		assert.strictEqual(estimated, 0.1 * ENTRY_COUNT + 1);
	});

	it('blends estimate and heuristic by confidence', () => {
		const table = makeTable({ indexEstimate: { count: 120, confidence: 0.5 } });
		const estimated = estimate(table, { attribute: 'attr', comparator: 'between', value: [5, 10] });
		assert.strictEqual(estimated, Math.round(0.5 * 120 + 0.5 * (0.1 * ENTRY_COUNT + 1)));
	});

	it('constructs a prefix upper bound for starts_with', () => {
		const table = makeTable({ indexEstimate: { count: 7, confidence: 1 } });
		const estimated = estimate(table, { attribute: 'attr', comparator: 'starts_with', value: 'ab' });
		assert.strictEqual(estimated, 7);
		const range = table.indices.attr.calls[0];
		assert.strictEqual(range.start, 'ab');
		assert.ok(range.end instanceof Uint8Array);
	});

	it('constructs composite bounds for prefix', () => {
		const table = makeTable({ indexEstimate: { count: 9, confidence: 1 } });
		const estimated = estimate(table, { attribute: 'attr', comparator: 'prefix', value: 'a' });
		assert.strictEqual(estimated, 9);
		assert.deepStrictEqual(table.indices.attr.calls[0], { start: ['a', null], end: ['a', MAXIMUM_KEY] });
	});

	it('constructs open ranges for gt/lt', () => {
		const table = makeTable({ indexEstimate: { count: 40, confidence: 1 } });
		assert.strictEqual(estimate(table, { attribute: 'attr', comparator: 'gt', value: 5 }), 40);
		assert.deepStrictEqual(table.indices.attr.calls[0], { start: 5, exclusiveStart: true });

		const table2 = makeTable({ indexEstimate: { count: 40, confidence: 1 } });
		assert.strictEqual(estimate(table2, { attribute: 'attr', comparator: 'lt', value: 5 }), 40);
		assert.deepStrictEqual(table2.indices.attr.calls[0], { end: 5 });
	});

	it('estimates primary-key ranges against the primary store', () => {
		const table = makeTable({ primaryEstimate: { count: 33, confidence: 1 } });
		const estimated = estimate(table, { attribute: 'id', comparator: 'ge', value: 100 });
		assert.strictEqual(estimated, 33);
		assert.deepStrictEqual(table.primaryStore.calls[0], { start: 100 });
	});

	it('keeps the fraction heuristics when the store cannot estimate', () => {
		const table = makeTable();
		assert.strictEqual(
			estimate(table, { attribute: 'attr', comparator: 'between', value: [5, 10] }),
			0.1 * ENTRY_COUNT + 1
		);
		assert.strictEqual(
			estimate(table, { attribute: 'attr', comparator: 'starts_with', value: 'ab' }),
			0.05 * ENTRY_COUNT + 1
		);
		assert.strictEqual(estimate(table, { attribute: 'attr', comparator: 'gt', value: 5 }), 0.3 * ENTRY_COUNT + 1);
	});

	it('never estimates below 1', () => {
		const table = makeTable({ indexEstimate: { count: 0, confidence: 1 } });
		const estimated = estimate(table, { attribute: 'attr', comparator: 'between', value: [5, 10] });
		assert.strictEqual(estimated, 1);
	});
});

// End-to-end against real stores; requires a rocksdb-js with estimateCount
// (feature-detected — skipped until the dependency ships it).
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const supportsEstimateCount = typeof RocksDatabase.prototype.estimateCount === 'function';

(supportsEstimateCount ? describe : describe.skip)('estimateCondition range estimates (real stores)', () => {
	const { setupTestDBPath } = require('../testUtils');
	const { table } = require('#src/resources/databases');
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	const N = 20000;
	let T;

	before(async function () {
		this.timeout(120000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'EstimateTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'score', type: 'Int', indexed: true },
				{ name: 'name', indexed: true },
			],
		});
		let last;
		for (let i = 0; i < N; i++) {
			last = T.put({ id: i, score: i, name: `name-${String(i).padStart(6, '0')}` });
		}
		await last;
		await T.primaryStore.flush();
		await T.indices.score.flush();
		await T.indices.name.flush();
	});

	it('scales between estimates with the real range width', () => {
		const est = estimateCondition(T);
		const narrow = est({ attribute: 'score', comparator: 'between', value: [1000, 1100] });
		const wide = est({ attribute: 'score', comparator: 'between', value: [1000, 11000] });
		assert.ok(narrow < wide, `narrow (${narrow}) should be < wide (${wide})`);
		// the wide range is half the table; the old heuristic would report
		// 0.1 * N + 1 for both
		assert.ok(wide > 0.15 * N, `wide (${wide}) should exceed the flat between heuristic`);
	});

	it('estimates starts_with from the real prefix range', () => {
		const est = estimateCondition(T);
		// all names share the "name-0" prefix up to 9999
		const broad = est({ attribute: 'name', comparator: 'starts_with', value: 'name-0' });
		const narrow = est({ attribute: 'name', comparator: 'starts_with', value: 'name-000' });
		assert.ok(narrow < broad, `narrow (${narrow}) should be < broad (${broad})`);
	});

	it('orders open-range estimates by real range width', () => {
		// The flat heuristic reported 30% + 1 for every open range; the
		// statistical estimate must at least order them. (Absolute accuracy at
		// this scale is block-granular — index entries are tiny, so a 20k-row
		// index spans few data blocks.)
		const est = estimateCondition(T);
		const tail10 = est({ attribute: 'score', comparator: 'gt', value: N - 2000 });
		const tail50 = est({ attribute: 'score', comparator: 'gt', value: N / 2 });
		assert.ok(tail10 < tail50, `10% tail (${tail10}) should be < 50% tail (${tail50})`);
		assert.ok(tail10 <= 0.3 * N + 1, `10% tail (${tail10}) should not exceed the flat heuristic`);
	});
});
