const { parentPort, workerData } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');

exports.handleApplication = async (scope) => {
	try {
		scope.server.socket((socket) => socket.end('admitted'), {
			port: workerData.probePort,
			name: 'admission-scope',
			...(workerData.probePool ? { threadType: 'replication' } : {}),
		});
		if (workerData.probePool) {
			const { SERVERS } = require('#src/server/serverRegistry');
			SERVERS[workerData.probePort].noReusePort = true;
			SERVERS[workerData.probePort].on('error', (error) => {
				if (error.code === 'EADDRINUSE') parentPort.postMessage({ type: 'admission-bind-error' });
			});
		}
		scope.on('close', async () => {
			await delay(workerData.probePool ? 1000 : 30);
			parentPort.postMessage({ type: 'admission-scope-disposed' });
		});
		const { whenComponentsLoaded } = await import('#src/server/threads/threadServer');
		whenComponentsLoaded.then(() => parentPort.postMessage({ type: 'admission-components-loaded' }));
		parentPort.postMessage({ type: 'admission-scope-loaded' });
		if (workerData.holdProbeLoad) {
			await new Promise((resolve) => {
				const release = (message) => {
					if (message.type !== 'release-admission-probe') return;
					parentPort.off('message', release);
					resolve();
				};
				parentPort.on('message', release);
			});
		}
	} catch (error) {
		parentPort.postMessage({ type: 'admission-fixture-error', message: error.message });
		throw error;
	}
};
