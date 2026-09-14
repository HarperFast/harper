'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { THREAD_TYPES } = require('#src/utility/hdbTerms');
const { startWorker, restartWorkers, shutdownWorkers, workers } = require('#js/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'restartThrottle-fixture.cjs');
const SERVING_TYPE = 'restart-throttle-serving';
const POOL_SIZE = 3;
// The topology they declare. Chosen so the default throttle is Math.floor(16 / 8) === 2: a pool whose
// expected throttle were 1 could not tell a preserved topology from a poisoned one clamped back to 1.
const DECLARED_THREADS = 16;
const EXPECTED_THROTTLE = 2;

describe('rolling restart throttle', function () {
	it('still throttles after a job worker has been started', async function () {
		this.timeout(60000);
		const concurrency = { down: 0, peak: 0 };
		const started = await startPool(concurrency);
		try {
			const jobWorker = await startFixtureWorker({ name: THREAD_TYPES.JOB });
			started.push(jobWorker);
			// A job worker that believes it is part of the pool behaves differently, so its own view stays empty.
			assert.equal(jobWorker.reportedWorkerCount, undefined);
			assert.equal(started[0].reportedWorkerCount, DECLARED_THREADS);

			const result = await restartWorkers(SERVING_TYPE, undefined, false);

			assert.equal(concurrency.peak, EXPECTED_THROTTLE);
			assert.equal(result.workersKeptOnOldCode, 0);
		} finally {
			await cleanUp(started);
		}
	});

	// Every one of these loses its relational comparisons, which would leave the loop with no throttle
	// at all rather than a bad one.
	for (const throttle of [Number.NaN, 'two', null]) {
		it(`treats a ${typeof throttle} throttle of ${String(throttle)} as the documented minimum of one`, async function () {
			this.timeout(60000);
			const concurrency = { down: 0, peak: 0 };
			const started = await startPool(concurrency);
			try {
				await restartWorkers(SERVING_TYPE, throttle, false);

				assert.equal(concurrency.peak, 1);
			} finally {
				await cleanUp(started);
			}
		});
	}

	it('keeps Infinity meaning "all at once", marked before the first await', async function () {
		this.timeout(60000);
		const concurrency = { down: 0, peak: 0 };
		const started = await startPool(concurrency);
		try {
			// shutdownWorkersNow() does not await this: it relies on every selected worker being marked and
			// signalled synchronously, before any worker has to exit.
			const shuttingDown = shutdownWorkers(SERVING_TYPE);
			assert.equal(concurrency.peak, POOL_SIZE);
			assert.deepEqual(
				started.map((worker) => worker.wasShutdown),
				started.map(() => true)
			);

			await shuttingDown;
		} finally {
			await cleanUp(started);
		}
	});
});

function startFixtureWorker(options) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			autoRestart: false,
			...options,
			onStarted(worker) {
				const onMessage = (message) => {
					if (message?.type !== 'fixture-ready') return;
					worker.off('message', onMessage);
					worker.reportedWorkerCount = message.workerCount;
					resolve(worker);
				};
				worker.on('message', onMessage);
				worker.once('error', reject);
				worker.once('exit', () => reject(new Error('fixture worker exited before reporting ready')));
			},
		});
	});
}

function trackDowntime(worker, concurrency) {
	worker.on('shutdown', () => {
		concurrency.down++;
		concurrency.peak = Math.max(concurrency.peak, concurrency.down);
	});
	worker.on('exit', () => concurrency.down--);
}

async function startPool(concurrency) {
	const started = [];
	for (let index = 0; index < POOL_SIZE; index++) {
		const worker = await startFixtureWorker({ name: SERVING_TYPE, workerIndex: index, threadCount: DECLARED_THREADS });
		trackDowntime(worker, concurrency);
		started.push(worker);
	}
	return started;
}

async function cleanUp(started) {
	for (const worker of started.reverse()) {
		if (!workers.includes(worker)) continue;
		worker.wasShutdown = true;
		await worker.terminate();
	}
}
