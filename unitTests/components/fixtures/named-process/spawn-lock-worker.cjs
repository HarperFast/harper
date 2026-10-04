const { parentPort, workerData } = require('node:worker_threads');
const { withSpawnPidLock } = require('#src/security/spawnPidFile');

const started = Date.now();
try {
	withSpawnPidLock(
		workerData.pidFile,
		() => {
			parentPort.postMessage({ acquired: true, elapsedMs: Date.now() - started });
		},
		workerData.timeoutMs
	);
} catch (error) {
	parentPort.postMessage({ error: error.message });
}
