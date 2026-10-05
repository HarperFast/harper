const { parentPort } = require('node:worker_threads');

exports.handleApplication = async (scope) => {
	scope.on(
		'close',
		() =>
			new Promise((resolve) => {
				setTimeout(() => {
					parentPort.postMessage({ type: 'component-disposed' });
					resolve();
				}, 30);
			})
	);
	parentPort.postMessage({ type: 'component-held' });
	await new Promise((resolve) => {
		const release = (message) => {
			if (message.type !== 'release-component') return;
			parentPort.off('message', release);
			resolve();
		};
		parentPort.on('message', release);
	});
};
