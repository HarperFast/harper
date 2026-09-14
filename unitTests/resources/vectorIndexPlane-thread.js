require('../testUtils');
const { parentPort } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { derivedIndexReadiness } = require('#src/resources/indexes/hnswDerivedIndex');

if (parentPort) {
	setupTestDBPath();
	setMainIsWorker(true);
	const PlaneTest = table({
		table: 'PlaneTest',
		database: 'vector-plane',
		audit: true,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'name', indexed: true },
			{
				name: 'vector',
				indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 },
				type: 'Array',
			},
		],
	});

	async function waitUntilReady() {
		await PlaneTest.indexingOperation;
		while (derivedIndexReadiness(PlaneTest.auditStore, PlaneTest.indices.vector.name).state !== 'ready')
			await new Promise((resolve) => setTimeout(resolve, 10));
	}

	void waitUntilReady().then(() =>
		parentPort.postMessage({
			type: 'ready',
			retainedMarker: PlaneTest.indices.vector.getSync('__native-plane-reopen-marker__'),
		})
	);
	parentPort.on('message', async (message) => {
		if (message.type === 'shutdown') process.exit(0);
		try {
			if (message.type === 'commitAndBlock') {
				await PlaneTest.put(message.record.id, message.record);
				parentPort.postMessage({ type: 'committed' });
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
				return;
			}
			if (message.type !== 'put') return;
			for (const record of message.records) await PlaneTest.put(record.id, record);
			parentPort.postMessage({ type: 'done' });
		} catch (error) {
			parentPort.postMessage({ type: 'error', message: error.message, stack: error.stack });
		}
	});
}
