// Table.get latency and CPU on RocksDB across record-cache states. Run on its own:
//   npx mocha unitTests/resources/table-get-latency.bench.js
require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { totalmem } = require('node:os');
const { resolveRocksMemoryConfig } = require('#src/utility/rocksMemoryConfig');

const SCALE = Number(process.env.BENCH_SCALE ?? 1);

describe('Table.get latency by cache state', function () {
	it('measures warm, VT-miss, block-cache-miss and cold reads', async function () {
		this.timeout(600_000);
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return this.skip();
		await main();
	});
});

async function measure(label, ids, n, before) {
	const latencies = new Float64Array(n);
	const cpuStart = process.cpuUsage();
	const wallStart = process.hrtime.bigint();
	for (let i = 0; i < n; i++) {
		const id = ids[i % ids.length];
		before?.(id);
		const t0 = process.hrtime.bigint();
		const record = await TestTable.get(id);
		latencies[i] = Number(process.hrtime.bigint() - t0);
		if (!record) throw new Error(`missing record ${id}`);
	}
	const wallNs = Number(process.hrtime.bigint() - wallStart);
	const cpu = process.cpuUsage(cpuStart);
	latencies.sort();
	const pct = (p) => (latencies[Math.min(n - 1, Math.floor(n * p))] / 1000).toFixed(2);
	console.log(
		`METRIC ${label} n=${n} p50_us=${pct(0.5)} p99_us=${pct(0.99)} p999_us=${pct(0.999)} ` +
			`cpu_us_per_op=${((cpu.user + cpu.system) / n).toFixed(2)} ops_per_s=${Math.round((n * 1e9) / wallNs)}`
	);
}

let TestTable;
async function main() {
	setupTestDBPath();
	setMainIsWorker(true);
	TestTable = table({
		table: 'TableGetLatencyBench',
		database: 'test',
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'payload' }],
	});
	const store = TestTable.primaryStore;
	const payload = 'x'.repeat(1000);

	const hotIds = [];
	for (let i = 0; i < 1000; i++) hotIds.push(i);
	for (const id of hotIds) await TestTable.put(id, { name: `hot ${id}`, payload: payload.slice(0, 200) });
	for (const id of hotIds) await TestTable.get(id);
	for (const id of hotIds) await TestTable.get(id);
	await measure('warm', hotIds, 20_000, null);
	await measure('warm', hotIds, 200_000 * SCALE, null);

	// the record cache still holds the value but its VT slot no longer vouches for it, as after a slot
	// collision; this and block-cache-miss charge populateVersion to cpu/ops, not to latency
	await measure('vt-miss', hotIds, 50_000 * SCALE, (id) => store.populateVersion(id, 1));

	const spreadIds = [];
	for (let i = 0; i < 20_000; i++) spreadIds.push(100_000 + i);
	// read in a strided order so neighbouring reads do not share a data block
	const stridedIds = spreadIds.map((_, i) => spreadIds[(i * 7919) % spreadIds.length]);
	const coldIds = [];
	for (let i = 0; i < 50_000 * SCALE; i++) coldIds.push(1_000_000 + i);
	const writes = [];
	for (const id of spreadIds) writes.push(TestTable.put(id, { name: `spread ${id}`, payload }));
	for (const id of coldIds) writes.push(TestTable.put(id, { name: `cold ${id}`, payload }));
	await Promise.all(writes);
	// hold the cached values strongly so the record cache keeps them through the eviction below
	const held = [];
	for (const id of spreadIds) held.push(await TestTable.get(id));
	store.flushSync();
	// the block cache is process-wide, so put back the default size afterwards
	RocksDatabase.config({ blockCacheSize: 1 << 20 });
	try {
		// cached value, VT miss, and its block evicted from RocksDB's block cache (still in the OS page cache)
		await measure('block-cache-miss', stridedIds, stridedIds.length, (id) => store.populateVersion(id, 1));
	} finally {
		RocksDatabase.config(
			resolveRocksMemoryConfig({ availableMemory: Math.min(process.constrainedMemory?.() || Infinity, totalmem()) })
		);
	}
	await measure('cold', coldIds, coldIds.length, null);
	if (held.length !== spreadIds.length) throw new Error('unreachable');
}
