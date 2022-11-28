const { startWorker, restartWorkers, shutdownWorkers } = require('../../../server/threads/start-threads');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');

describe('(Re)start workers', () => {
	let workers = [];
	before(function() {
		workers = startHTTPThreads(4);
	});
	it('Start worker', async function () {
		let worker1StartedCount = 0;
		let worker1Started;
		startWorker('unitTests/server/threads/thread-for-tests', {
			resourceLimits: {
				maxOldGenerationSizeMb: 16,
				maxYoungGenerationSizeMb: 16,
			},
			onStarted() {
				worker1StartedCount++;
				if (worker1Started)
					worker1Started();
			}
		});
		worker2 = startWorker('unitTests/server/threads/thread-for-tests');
		assert.equal(worker1StartedCount, 1);
		worker1.postMessage({ type: 'throw-error'});
		await new Promise(resolve => worker1Started = resolve);
		assert.equal(worker1StartedCount, 2);
		worker1.postMessage({ type: 'oom'});
		await new Promise(resolve => worker1Started = resolve);
		assert.equal(worker1StartedCount, 3);
	});

	after(function() {
		shutdownWorkers(terms.SERVICES.HDB_CORE);
	});
});
