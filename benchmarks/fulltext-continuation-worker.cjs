const { parentPort, threadId, workerData } = require('node:worker_threads');
workerData.noServerStart = true;
const { onMessageByType } = require('#js/server/threads/manageThreads');
let Product, Control, runBenchmark;
const context = { user: { username: 'benchmark', role: { permission: { super_user: true } } } };
onMessageByType('fulltext-benchmark-command', async (event) => {
	const { id, body } = event.message;
	try {
		let value;
		if (body.action === 'initialize') {
			const { setupTestDBPath } = require('../unitTests/testUtils');
			const { table } = require('#src/resources/databases');
			runBenchmark = require('./fulltext-continuation/measure.cjs').runBenchmark;
			setupTestDBPath();
			Product = table({
				database: body.database,
				table: 'Product',
				audit: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{ name: 'owner', type: 'String' },
				],
				fullTextIndexes: [
					{
						name: 'catalogSearch',
						fields: [{ name: 'title', weight: 1 }],
						analyzer: 'english@2',
						stopWords: true,
						positions: true,
						surfaceTerms: true,
						synonyms: [],
					},
				],
			});
			Control = table({
				database: body.database,
				table: 'Control',
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'value', type: 'String' },
				],
			});
			await Control.put('control', { value: 'ready' });
			value = { worker: threadId };
		} else if (body.action === 'seed') {
			for (let start = 0; start < body.size; start += 2000)
				await Product.put(
					Array.from({ length: Math.min(2000, body.size - start) }, (_, n) => ({
						id: `p${String(start + n).padStart(6, '0')}`,
						title: start + n === body.size - 1 ? 'widget lastmarker' : 'widget',
						owner: (start + n) % 500 === 0 ? 'rare' : 'common',
					}))
				);
			value = { worker: threadId };
		} else if (body.action === 'shutdown') {
			await Product?.derivedIndexRuntime?.close();
			value = {};
		} else value = await runBenchmark(body, Product, Control, context);
		parentPort.postMessage({ type: 'fulltext-benchmark-result', message: { originator: threadId, id, value } });
	} catch (error) {
		parentPort.postMessage({
			type: 'fulltext-benchmark-result',
			message: { originator: threadId, id, error: { message: error.message, stack: error.stack } },
		});
	}
});
parentPort.ref();
parentPort.postMessage({ type: 'fulltext-benchmark-result', message: { originator: threadId, ready: true } });
