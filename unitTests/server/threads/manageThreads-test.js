const {
	startWorker,
	restartWorkers,
	shutdownWorkers,
	workers,
	getThreadInfo,
} = require('../../../server/threads/manageThreads');
const assert = require('assert');

describe('(Re)start/monitor workers', () => {
	before(async function () {
		await shutdownWorkers();
	});
	it('Start worker and handle errors/restarts', async function () {
		this.timeout(10000);
		let worker1StartedCount = 0;
		let worker2StartedCount = 0;
		let worker1Started;
		let worker1;
		worker1 = startWorker('unitTests/server/threads/thread-for-tests', {
			name: 'test',
			resourceLimits: {
				maxOldGenerationSizeMb: 64,
				maxYoungGenerationSizeMb: 16,
			},
			onStarted(worker) {
				worker1 = worker;
				worker1StartedCount++;
				if (worker1Started) worker1Started();
			},
		});
		startWorker('unitTests/server/threads/thread-for-tests', {
			name: 'test',
			onStarted() {
				worker2StartedCount++;
			},
		});
		assert.equal(worker1StartedCount, 1);
		worker1.postMessage({ type: 'throw-error' });
		await new Promise((resolve) => (worker1Started = resolve));
		assert.equal(worker1StartedCount, 2);
		worker1.postMessage({ type: 'oom' });
		await new Promise((resolve) => (worker1Started = resolve));
		assert.equal(worker1StartedCount, 3);
		await restartWorkers('test', 1);
		assert.equal(worker1StartedCount, 4);
		assert.equal(worker2StartedCount, 2);
	});
	it('Broadcast through "itc"', async function () {
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'itc-test' });
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'itc-test' });
		worker1.postMessage({ type: 'broadcast1' });
		await new Promise((resolve) => {
			worker2.on('message', (event) => {
				if (event.type === 'received-broadcast') {
					resolve();
				}
			});
		});
		threads.sendToThread(worker1.threadId, { type: 'broadcast1' });
		await new Promise((resolve) => {
			threads.onMessageByType('received-broadcast', (event, thread) => {
				assert.equal(worker2.threadId, thread.threadId);
				resolve(event);
			});
		});
	});
	it('getThreadInfo should return stats', async function () {
		this.timeout(5000);
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'gti-test' });
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'gti-test' });
		await new Promise((resolve) => setTimeout(resolve, 3500)); // wait for resources to be reported
		let worker_info = await getThreadInfo();
		assert(worker_info.length >= 2);
		let worker = worker_info[worker_info.length - 1];
		// these values are important to ensure that they are reported
		assert(worker.heapUsed);
		assert(worker.arrayBuffers);
		assert(worker.active);
	});
	it('Shutdown workers', async function () {
		let initial_workers_num = workers.length;
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'test' });
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'test' });
		await shutdownWorkers('test');
		assert(workers.length < initial_workers_num + 2);
	});

	afterEach(async function () {
		await shutdownWorkers();
		/*for (let worker of workers) {
			worker.terminate();
		}*/
	});
});
