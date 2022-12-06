const { startWorker, restartWorkers, shutdownWorkers, workers } = require('../../../server/threads/start-threads');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');

describe('(Re)start workers', () => {
	let workers = [];
	it('Start worker and handle errors/restarts', async function () {
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
				if (worker1Started)
					worker1Started();
			},
		});
		startWorker('unitTests/server/threads/thread-for-tests', {
			name: 'test',
			onStarted() {
				worker2StartedCount++;
			}
		});
		assert.equal(worker1StartedCount, 1);
		worker1.postMessage({type: 'throw-error'});
		await new Promise(resolve => worker1Started = resolve);
		assert.equal(worker1StartedCount, 2);
		worker1.postMessage({type: 'oom'});
		await new Promise(resolve => worker1Started = resolve);
		assert.equal(worker1StartedCount, 3);
		await restartWorkers('test', 1);
		assert.equal(worker1StartedCount, 4);
		assert.equal(worker2StartedCount, 2);
	});
	it('Broadcast through "itc"', async function() {
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests');
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests');
		worker1.postMessage({ type: 'broadcast1'});
		await new Promise(resolve => {
			worker2.on('message', (event) => {
				if (event.type === 'received-broadcast')
					resolve();
			});
		});
	});
	it('Shutdown workers', async function() {
		let initial_workers_num = workers.length;
		let worker1 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'test'});
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests', { name: 'test'});
		await shutdownWorkers('test');
		assert.equal(workers.length, initial_workers_num);
	});

	afterEach(function() {
		shutdownWorkers(terms.SERVICES.HDB_CORE);
	});
});
