const { parentPort } = require('node:worker_threads');

parentPort.postMessage({
	type: 'runtime-condition',
	modulePath: require.resolve('#src/server/Server'),
	execArgv: process.execArgv,
});
