const { parentPort } = require('node:worker_threads');
const { table } = require('../../resources/databases.ts');

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
