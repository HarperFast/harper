const { parentPort } = require('node:worker_threads');

exports.handleApplication = async (scope) => {
	parentPort.postMessage({ type: 'component-held' });
	await new Promise((resolve) => {
		const release = (message) => {
			if (message.type !== 'release-component') return;
			parentPort.off('message', release);
			resolve();
		};
		parentPort.on('message', release);
	});
	scope.on('close', () => {
		parentPort.postMessage({ type: 'component-disposed' });
	});
	parentPort.postMessage({ type: 'component-loaded' });
};
