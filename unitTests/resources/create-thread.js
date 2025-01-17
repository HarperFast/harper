require('../test_utils');
const { parentPort } = require('worker_threads');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
// might want to enable an iteration with NATS being assigned as a source

getMockLMDBPath();
setMainIsWorker(true);
let CreateTest = table({
	table: 'CreateTest',
	database: 'test',
	attributes: [
		{ name: 'id', type: 'Int', isPrimaryKey: true },
		{ name: 'str', type: 'String' },
	],
});
parentPort
	?.on('message', (message) => {
		if (message.type === 'shutdown') {
			process.exit(0);
		}
		if (message.type === 'increment') {
			for (let i = 0; i < 100; i++) CreateTest.getNewId();
			parentPort.postMessage({ type: 'incremented' });
		}
	})
	.ref();
/*(async () => {
	try {
		let results = [];
		results.push(await CreateTest.create({ str: 'hello' }));
		results.push(await CreateTest.create({ str: 'hello' }));
		console.log(results);
	} catch (error) {
		console.error(error);
	}
})();*/
