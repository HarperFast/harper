const { parentPort } = require('node:worker_threads');
const { onStartup, runStartup } = require('#src/utility/lifecycle');

onStartup(async () => {
	parentPort.postMessage({ type: 'startup-held' });
	await new Promise((resolve) => {
		const release = (message) => {
			if (message.type !== 'release-startup') return;
			parentPort.off('message', release);
			resolve();
		};
		parentPort.on('message', release);
	});
	const { trackScopeClose } = require('#src/components/scopeShutdown');
	trackScopeClose(
		new Promise((resolve) =>
			setTimeout(() => {
				parentPort.postMessage({ type: 'scope-disposed' });
				resolve();
			}, 30)
		)
	);
	setImmediate(async () => {
		await runStartup();
		parentPort.postMessage({ type: 'startup-drained' });
	});
});
