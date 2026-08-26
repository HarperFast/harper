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
	store.getEntry(1);

	const N = 2_000_000;
	for (let i = 0; i < 100_000; i++) store.getEntry(1);
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < N; i++) store.getEntry(1);
	const t1 = process.hrtime.bigint();
	const warmNs = Number(t1 - t0) / N;

	console.log(`warm getEntry: ${warmNs.toFixed(0)} ns/op (${(1e9 / warmNs / 1e6).toFixed(2)} M ops/s)`);
	process.exit(0);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
