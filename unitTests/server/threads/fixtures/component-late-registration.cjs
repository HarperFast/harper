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
	// unref'd, like a native runtime's disposal: only the shutdown's own keep-alive holds the worker open for it
	scope.on(
		'close',
		() =>
			new Promise((resolve) => {
				setTimeout(() => {
					parentPort.postMessage({ type: 'component-disposed' });
					resolve();
				}, 100).unref();
			})
	);
	parentPort.postMessage({ type: 'component-loaded' });
};
