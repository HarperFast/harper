const { parentPort, workerData } = require('node:worker_threads');
require('../../../mocha.init.js');
const { scopedImport } = require('#src/security/jsLoader');
const { join } = require('node:path');

(async () => {
	const api = await scopedImport(join(__dirname, 'spawn-api.mjs'), { mode: 'vm-current-context', allowedPath: __dirname });
	parentPort.postMessage({ ready: true });
	parentPort.once('message', () => {
		const child = api.fork(join(__dirname, 'spawn-child.cjs'), [], { name: workerData.name, stdio: 'ignore' });
		parentPort.postMessage({ spawnedPid: child.pid });
	});
})().catch((error) => { throw error; });
