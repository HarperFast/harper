const {
	startWorker,
	restartWorkers,
	shutdownWorkers,
	workers,
	getThreadInfo,
} = require('../../../server/threads/manage-threads');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');
const { threadId } = require('worker_threads');

describe('(Re)start/monitor workers', () => {
	before(async function () {
		await shutdownWorkers();
	});
	it.skip('Start worker and handle errors/restarts', async function () {
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
		console.log('starting broadcast test');
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests');
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests');
		console.log('started broadcast threads');
		worker1.postMessage({ type: 'broadcast1' });
		console.log('send broadcast request');
		await new Promise((resolve) => {
			worker2.on('message', (event) => {
				if (event.type === 'received-broadcast') resolve();
			});
		});
		console.log('received broadcast response');
	});
	it('getThreadInfo should return stats', async function () {
		this.timeout(5000);
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests');
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests');
		await new Promise((resolve) => setTimeout(resolve, 2000)); // wait for resources to be reported
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
		for (let worker of workers) {
			worker.terminate();
		}
	});
});
