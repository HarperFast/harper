const { parentPort } = require('node:worker_threads');

exports.handleApplication = async (scope) => {
	parentPort.postMessage({ type: 'second-started' });
	scope.on('close', () => parentPort.postMessage({ type: 'second-disposed' }));
};
