const { Resource, server } = require('../../index');
const { parentPort } = require('worker_threads');
if (parentPort) {
	parentPort.postMessage({
		hasResource: Resource !== undefined,
		hasServer: server !== undefined,
	});
}
