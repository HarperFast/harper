require('../testUtils');
const { parentPort } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { database } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

setupTestDBPath();
setMainIsWorker(true);
const rootStore = database({ database: 'test', table: null });
parentPort
	?.on('message', (message) => {
		if (message.type === 'hold-lock') {
			const acquired = rootStore.tryLock('update-attributes');
			parentPort.postMessage({ type: 'held', acquired });
			setTimeout(() => {
				rootStore.unlock('update-attributes');
			}, message.holdTime);
		} else if (message.type === 'shutdown') {
			process.exit(0);
		}
	})
	.ref();
