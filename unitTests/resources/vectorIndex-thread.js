require('../testUtils');
const { parentPort } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

setupTestDBPath();
setMainIsWorker(true);
const HNSWConcurrentTest = table({
	table: 'HNSWConcurrentTest',
	database: 'test',
	attributes: [
		{ name: 'id', isPrimaryKey: true },
		{ name: 'embedding', indexed: { type: 'HNSW' }, type: 'Array' },
	],
});

parentPort
	?.on('message', async (msg) => {
		if (msg.type === 'shutdown') process.exit(0);
		if (msg.type === 'insert') {
			try {
				const puts = [];
				for (let i = 0; i < msg.count; i++) {
					const id = msg.start + i;
					const embedding = Array.from({ length: msg.dims }, () => Math.random() * 2 - 1);
					puts.push(HNSWConcurrentTest.put(id, { embedding }));
				}
				await Promise.all(puts);
				parentPort.postMessage({ type: 'done', start: msg.start });
			} catch (err) {
				console.error('concurrent failed', err);
				parentPort.postMessage({
					type: 'error',
					start: msg.start,
					message: err.message,
					stack: err.stack,
				});
			}
		}
	})
	.ref();