require('../testUtils');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function main() {
	setupTestDBPath();
	setMainIsWorker(true);
	const TestTable = table({
		table: 'CacheProbeBench',
		database: 'test',
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
	});
	const store = TestTable.primaryStore;
	await TestTable.put(1, { name: 'warm', payload: 'x'.repeat(200) });
	await TestTable.get(1); // warm cache + VT
	const entry = store.getEntry(1);
	const version = entry.version;

	const N = 2_000_000;
	// warm getEntry (includes the new sentinel probe)
	let t0 = process.hrtime.bigint();
	for (let i = 0; i < N; i++) store.getEntry(1);
	let t1 = process.hrtime.bigint();
	const warmNs = Number(t1 - t0) / N;

	// bare verifyVersion — the added per-read probe in isolation
	t0 = process.hrtime.bigint();
	for (let i = 0; i < N; i++) store.verifyVersion(1, version);
	t1 = process.hrtime.bigint();
	const probeNs = Number(t1 - t0) / N;

	console.log(`warm getEntry (with probe): ${warmNs.toFixed(0)} ns/op (${(1e9 / warmNs / 1e6).toFixed(2)} M ops/s)`);
	console.log(`verifyVersion probe alone:  ${probeNs.toFixed(0)} ns/op`);
	console.log(`probe share of warm read:   ${((probeNs / warmNs) * 100).toFixed(1)}%`);
	console.log(
		`estimated pre-change warm:  ${(warmNs - probeNs).toFixed(0)} ns/op → overhead ${((probeNs / (warmNs - probeNs)) * 100).toFixed(1)}%`
	);
	process.exit(0);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
