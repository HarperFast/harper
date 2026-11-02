/**
 * Benchmark: per-row cost of a secondary-index range query with and without a select.
 *
 * Run via: npm run bench (or mocha on this file alone)
 * Each case prints one `BENCH {json}` line (per-query median/mean in µs, rows/s, and heap bytes
 * allocated per row, GC count and GC ms in the measured window) so runs from two builds can be
 * compared side by side.
 */
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { GCProfiler, getHeapStatistics } = require('node:v8');

const RECORD_COUNT = Number(process.env.BENCH_RECORDS ?? 20_000);
const RANGE_SIZE = Number(process.env.BENCH_RANGE ?? 2_000);
const ITERATIONS = Number(process.env.BENCH_ITERS ?? 300);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 50);
const RANGE_START = 5_000;

describe('Benchmark: secondary-index range select', function () {
	this.timeout(0);
	let Records;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			table: 'IndexRangeSelectBench',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'score', indexed: true },
				{ name: 'name' },
				{ name: 'category' },
				{ name: 'payload' },
			],
		});
		const payload = 'x'.repeat(100);
		for (let start = 0; start < RECORD_COUNT; start += 500) {
			const puts = [];
			for (let id = start; id < Math.min(start + 500, RECORD_COUNT); id++) {
				puts.push(Records.put(id, { score: id, name: `name-${id}`, category: `cat-${id % 10}`, payload }));
			}
			await Promise.all(puts);
		}
	});

	after(function () {
		Records.dropTable();
	});

	const query = (select) => ({
		conditions: [{ attribute: 'score', comparator: 'between', value: [RANGE_START, RANGE_START + RANGE_SIZE - 1] }],
		select,
	});

	async function runCase(label, select, { sync = false, cold = false, iterations = ITERATIONS } = {}) {
		async function once() {
			if (cold) Records.primaryStore.cache?.clear();
			let rows = 0;
			if (sync) {
				for (const _ of Records.search(query(select))) rows++;
			} else {
				for await (const _ of Records.search(query(select))) rows++;
			}
			if (rows !== RANGE_SIZE) throw new Error(`expected ${RANGE_SIZE} rows, got ${rows}`);
		}
		for (let i = 0; i < WARMUP; i++) await once();
		global.gc?.();
		const profiler = new GCProfiler();
		profiler.start();
		const heapAtStart = getHeapStatistics().used_heap_size;
		const times = [];
		const started = performance.now();
		for (let i = 0; i < iterations; i++) {
			const t0 = performance.now();
			await once();
			times.push(performance.now() - t0);
		}
		const elapsed = performance.now() - started;
		const heapAtEnd = getHeapStatistics().used_heap_size;
		const { statistics } = profiler.stop();
		// bytes reclaimed by each GC plus net heap growth = bytes allocated in the window
		let allocated = heapAtEnd - heapAtStart;
		let gcMs = 0;
		for (const gc of statistics) {
			allocated += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
			gcMs += gc.cost / 1000;
		}
		times.sort((a, b) => a - b);
		const result = {
			case: label,
			medianUs: Math.round(times[times.length >> 1] * 1000),
			meanUs: Math.round((elapsed / iterations) * 1000),
			rowsPerSec: Math.round((RANGE_SIZE * iterations) / (elapsed / 1000)),
			bytesPerRow: Math.round(allocated / (RANGE_SIZE * iterations)),
			gcCount: statistics.length,
			gcMs: Math.round(gcMs),
		};
		console.log('BENCH ' + JSON.stringify(result));
	}

	it('select 4 columns, async iteration', () => runCase('select4-async', ['id', 'score', 'name', 'category']));
	it('select 4 columns, sync iteration', () =>
		runCase('select4-sync', ['id', 'score', 'name', 'category'], { sync: true }));
	it('select 3 columns and a resolver, async iteration', () =>
		runCase('mixed-async', ['id', 'score', 'name', '$updatedtime']));
	it('full record, async iteration', () => runCase('full-async', undefined));
	it('select 4 columns, cold record cache', () =>
		runCase('select4-cold', ['id', 'score', 'name', 'category'], {
			cold: true,
			iterations: Math.ceil(ITERATIONS / 10),
		}));
});
