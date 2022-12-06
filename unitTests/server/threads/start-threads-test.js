const { startWorker, restartWorkers, shutdownWorkers } = require('../../../server/threads/start-threads');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');

describe('(Re)start workers', () => {
	let workers = [];
	before(function() {
		//workers = startHTTPThreads(4);
	});
	it('Start worker', async function () {
		let worker1StartedCount = 0;
		let worker1Started;
		let worker1;
		worker1 = startWorker('unitTests/server/threads/thread-for-tests', {
			resourceLimits: {
				maxOldGenerationSizeMb: 48,
				maxYoungGenerationSizeMb: 16,
			},
			onStarted(worker) {
				worker1 = worker;
				worker1StartedCount++;
				if (worker1Started)
					worker1Started();
			},
		});
		let worker2 = startWorker('unitTests/server/threads/thread-for-tests');
		assert.equal(worker1StartedCount, 1);
		worker1.postMessage({ type: 'throw-error'});
		await new Promise(resolve => worker1Started = resolve);
		assert.equal(worker1StartedCount, 2);
		worker1.postMessage({ type: 'oom'});
		await new Promise(resolve => worker1Started = resolve);
		assert.equal(worker1StartedCount, 3);
		worker1.postMessage({ type: 'broadcast1'});
		await new Promise(resolve => {
			worker2.on('message', (event) => {
				if (event.type === 'received-broadcast')
					resolve();
			});
		});
		await shutdownWorkers(terms.SERVICES.HDB_CORE);

	});

	after(function() {
		shutdownWorkers(terms.SERVICES.HDB_CORE);
	});
});
