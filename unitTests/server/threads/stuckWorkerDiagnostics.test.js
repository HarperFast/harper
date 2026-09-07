'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { replace, restore, fake } = require('sinon');
const harperLogger = require('#js/utility/logging/harper_logger');
const { startWorker, broadcastWithAcknowledgement, workers } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../../waitFor.js');

const FIXTURE = path.join(__dirname, 'stuckWorker-fixture.cjs');

function startFixtureWorker(acknowledge) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name: 'http',
			workerIndex: 0,
			threadCount: 1,
			autoRestart: false,
			argv: acknowledge ? ['--acknowledge'] : [],
			onStarted(worker) {
				worker.on('message', (message) => {
					if (message.type === 'fixture-ready') resolve(worker);
				});
				worker.once('error', reject);
				worker.once('exit', (code) => reject(new Error(`Worker exited before reporting (code ${code})`)));
			},
		});
	});
}

describe('stuck worker diagnostics on ITC ack timeout', function () {
	this.timeout(30000);
	let warnings;
	let started;
	beforeEach(() => {
		warnings = [];
		started = [];
		replace(
			harperLogger,
			'warn',
			fake((...args) => warnings.push(args.join(' ')))
		);
	});
	afterEach(async () => {
		restore();
		for (const worker of started) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('logs the blocked worker thread state twice and settles the broadcast', async function () {
		if (process.platform !== 'linux') this.skip();
		const worker = await startFixtureWorker(false);
		started.push(worker);
		await waitFor(() => worker.osThreadId !== undefined);
		assert.ok(Number.isInteger(worker.osThreadId) && worker.osThreadId > 0);

		// Two overlapping timeouts share one diagnostic.
		await Promise.all([
			broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 200),
			broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 200),
		]);
		const timeoutWarnings = warnings.filter((line) => line.includes('not acknowledged by worker thread(s)'));
		assert.equal(timeoutWarnings.length, 2);
		assert.ok(timeoutWarnings[0].includes(`thread(s) ${worker.threadId} within 200ms`));
		const snapshots = warnings.filter((line) => line.startsWith(`Worker thread ${worker.threadId} at ack timeout:`));
		assert.equal(snapshots.length, 1, warnings.join('\n'));
		assert.ok(snapshots[0].includes(`os tid ${worker.osThreadId} state=S`), snapshots[0]);
		assert.ok(/ctxtSwitches=\d+\/\d+/.test(snapshots[0]), snapshots[0]);
		assert.ok(!/ 0x[0-9a-f]+/.test(snapshots[0]), 'register values must not be logged');

		const progress = await waitFor(
			() => warnings.find((line) => line.startsWith(`Worker thread ${worker.threadId} over the next`)),
			{ timeout: 5000 }
		);
		assert.ok(/cpuTicks \+0 ctxtSwitches \+0\/\+\d+ state=S/.test(progress), progress);
		assert.ok(/event loop active \+\d+ms idle \+0ms/.test(progress), progress);
	});

	it('reports a worker that exits between the two samples, and one without an OS thread id', async function () {
		if (process.platform !== 'linux') this.skip();
		const worker = await startFixtureWorker(false);
		started.push(worker);
		await waitFor(() => worker.osThreadId !== undefined);
		worker.osThreadId = undefined;
		await broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 100);
		const snapshot = warnings.find((line) => line.startsWith(`Worker thread ${worker.threadId} at ack timeout:`));
		assert.ok(snapshot.includes('os thread state unavailable'), snapshot);
		worker.wasShutdown = true;
		await worker.terminate();
		await waitFor(() => !workers.includes(worker));
		await waitFor(() => warnings.find((line) => line.includes('exited before its follow-up sample')), {
			timeout: 5000,
		});
	});

	it('produces no diagnostics for a worker that acknowledges', async function () {
		const worker = await startFixtureWorker(true);
		started.push(worker);
		await broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 2000);
		assert.deepEqual(
			warnings.filter((line) => line.includes('Worker thread') || line.includes('not acknowledged')),
			[]
		);
	});
});
