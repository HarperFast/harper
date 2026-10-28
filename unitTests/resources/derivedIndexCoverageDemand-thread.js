require('../testUtils');
const { parentPort } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const vector = [1, 0, 0, 0];

function defineTables() {
	const Product = table({
		database: 'coverage-demand',
		table: 'Product',
		audit: true,
		attributes: [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'vector', type: 'Array', indexed: { type: 'HNSW', nativePlane: true } },
		],
	});
	const Other = table({
		database: 'coverage-demand',
		table: 'Other',
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	return { Product, Other };
}

function search(index, waitForIndexMilliseconds) {
	return index.search(
		{ target: vector, comparator: 'sort', distance: 'cosine', ef: 200, waitForIndexMilliseconds },
		{ transaction: undefined }
	);
}

module.exports = { defineTables, search, vector };

if (parentPort) {
	setupTestDBPath();
	setMainIsWorker(true);
	const { Product, Other } = defineTables();
	const index = Product.indices.vector.customIndex;

	async function waitUntilReady() {
		await Product.indexingOperation;
		while (index.derivedHost?.readiness().state !== 'ready') await new Promise((resolve) => setTimeout(resolve, 10));
	}

	void waitUntilReady().then(() => parentPort.postMessage({ type: 'ready' }));
	parentPort.on('message', async (message) => {
		try {
			const Table = message.table === 'Product' ? Product : Other;
			await Table.put(message.id, message.record);
			await new Promise((resolve) => setTimeout(resolve, message.pauseMilliseconds));
			const started = performance.now();
			const results = await search(index, message.waitForIndexMilliseconds);
			parentPort.postMessage({
				type: 'searched',
				elapsed: performance.now() - started,
				keys: results.map(({ key }) => key),
			});
		} catch (error) {
			parentPort.postMessage({ type: 'error', message: error.message, code: error.code, stack: error.stack });
		}
	});
}
