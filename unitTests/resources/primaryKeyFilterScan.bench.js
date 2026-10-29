/**
 * Benchmark: per-row cost of a filtered primary-key scan (`id=ne=`, matching every row), read for keys
 * only, through Table.search with a select, through a many-to-many join, and as an id filter beside a
 * secondary-index lead.
 *
 * Run via mocha on this file alone, once per build; each case prints one `BENCH {json}` line (median ms
 * per query, ns and CPU ns per row, heap bytes allocated per row, GC ms in the measured window).
 */
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { searchByIndex } = require('#src/resources/search');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { GCProfiler, getHeapStatistics } = require('node:v8');

const ROWS = Number(process.env.BENCH_RECORDS ?? 20_000);
const ITERATIONS = Number(process.env.BENCH_ITERS ?? 60);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 15);

describe('Benchmark: filtered primary-key scan', function () {
	this.timeout(0);
	let Rows, Parent;
	const notMissing = { attribute: 'id', comparator: 'ne', value: 'zzzz' };

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			database: 'bench_pk_filter',
			table: 'PkFilterRows',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'category', type: 'String', indexed: true },
				{ name: 'payload', type: 'String' },
			],
		});
		const Child = table({
			database: 'bench_pk_filter',
			table: 'PkFilterChild',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
				{ name: 'payload', type: 'String' },
			],
		});
		Parent = table({
			database: 'bench_pk_filter',
			table: 'PkFilterParent',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childIds', elements: { type: 'ID' }, indexed: true },
				{
					name: 'children',
					elements: { type: 'PkFilterChild', definition: { tableClass: Child } },
					relationship: { from: 'childIds' },
				},
			],
		});
		const payload = 'x'.repeat(100);
		const key = (i) => 'r' + String(i).padStart(6, '0');
		for (let start = 0; start < ROWS; start += 500) {
			const puts = [];
			for (let i = start; i < Math.min(start + 500, ROWS); i++) {
				puts.push(Rows.put(key(i), { id: key(i), name: `name-${i}`, category: `cat-${i % 10}`, payload }));
				puts.push(Child.put('c' + key(i), { id: 'c' + key(i), name: `child-${i}`, payload }));
				if (i % 2 === 0)
					puts.push(Parent.put('p' + key(i), { id: 'p' + key(i), childIds: ['c' + key(i), 'c' + key(i + 1)] }));
			}
			await Promise.all(puts);
		}
	});

	async function runCase(name, expected, once) {
		for (let i = 0; i < WARMUP; i++) {
			const rows = await once();
			if (rows !== expected) throw new Error(`${name}: expected ${expected} rows, got ${rows}`);
		}
		global.gc?.();
		const profiler = new GCProfiler();
		profiler.start();
		const heapAtStart = getHeapStatistics().used_heap_size;
		const cpuAtStart = process.cpuUsage();
		const times = [];
		for (let i = 0; i < ITERATIONS; i++) {
			const t0 = performance.now();
			await once();
			times.push(performance.now() - t0);
		}
		const cpu = process.cpuUsage(cpuAtStart);
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
		const median = times[times.length >> 1];
		console.log(
			'BENCH ' +
				JSON.stringify({
					case: name,
					medianMs: +median.toFixed(3),
					nsPerRow: Math.round((median * 1e6) / expected),
					cpuNsPerRow: Math.round(((cpu.user + cpu.system) * 1000) / (expected * ITERATIONS)),
					bytesPerRow: Math.round(allocated / (expected * ITERATIONS)),
					gcMs: Math.round(gcMs),
				})
		);
	}

	async function count(iterable, sync) {
		let rows = 0;
		if (sync) for (const _ of iterable) rows++;
		else for await (const _ of iterable) rows++;
		return rows;
	}
	const keyScan = () => searchByIndex(notMissing, Rows._readTxnForContext({}), false, Rows);
	const selectRows = (conditions) => Rows.search({ enforceExecutionOrder: true, conditions, select: ['id', 'name'] });

	it('read for keys, sync', () => runCase('scan-keys-sync', ROWS, () => count(keyScan(), true)));
	it('read for keys, async', () => runCase('scan-keys-async', ROWS, () => count(keyScan())));
	it('Table.search with a select, sync', () =>
		runCase('search-select-sync', ROWS, () => count(selectRows([notMissing]), true)));
	it('Table.search with a select, async', () =>
		runCase('search-select-async', ROWS, () => count(selectRows([notMissing]))));
	it('secondary-index lead with a primary-key sibling, async', () =>
		runCase('index-lead-pk-sibling-async', ROWS / 10, () =>
			count(selectRows([{ attribute: 'category', value: 'cat-3' }, notMissing]))
		));
	it('many-to-many join on the related primary key, async', () =>
		runCase('join-m2m-async', ROWS / 2, () =>
			count(
				Parent.search({
					conditions: [{ attribute: ['children', 'id'], comparator: 'ne', value: 'zzzz' }],
					select: ['id'],
				})
			)
		));
});
