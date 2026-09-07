'use strict';

const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const harperLogger = require('#src/utility/logging/harper_logger');
const {
	startWorker,
	broadcastWithAcknowledgement,
	onMessageFromWorkers,
	workers,
} = require('#js/server/threads/manageThreads');
const { pinLogConfig } = require('../../logConfigFixture.js');
const { waitFor } = require('../../waitFor.js');

const FIXTURE = path.join(__dirname, 'stuckWorker-fixture.cjs');

function startFixtureWorker(mode) {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name: 'http',
			workerIndex: 0,
			threadCount: 2,
			autoRestart: false,
			argv: [`--${mode}`],
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

// The main thread acks a worker-originated probe the way itc.js does for real broadcasts.
onMessageFromWorkers((message, port) => {
	if (message.type === 'diagnostic-probe' && message.requestId && port)
		port.postMessage({ type: 'ack', id: message.requestId });
});

describe('stuck worker diagnostics on ITC ack timeout', function () {
	this.timeout(30000);
	let restoreLogConfig;
	let logStart;
	let started;
	const logLines = () => {
		try {
			return readFileSync(harperLogger.getLogFilePath(), 'utf8').slice(logStart).split('\n');
		} catch {
			return [];
		}
	};
	const logLine = (fragment) => logLines().find((line) => line.includes(fragment));
	before(() => {
		restoreLogConfig = pinLogConfig({ level: 'warn' });
	});
	after(() => restoreLogConfig?.());
	beforeEach(() => {
		started = [];
		try {
			logStart = readFileSync(harperLogger.getLogFilePath(), 'utf8').length;
		} catch {
			logStart = 0;
		}
	});
	afterEach(async () => {
		for (const worker of started) {
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('logs the blocked worker thread state twice and settles the broadcast', async function () {
		if (process.platform !== 'linux') this.skip();
		const worker = await startFixtureWorker('block');
		started.push(worker);
		await waitFor(() => worker.osThreadId !== undefined);
		assert.ok(Number.isInteger(worker.osThreadId) && worker.osThreadId > 0);

		await Promise.all([
			broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 200),
			broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 200),
		]);
		await waitFor(() => logLine(`Worker thread ${worker.threadId} at ack timeout:`));
		const lines = logLines();
		assert.equal(lines.filter((line) => line.includes('not acknowledged by worker thread(s)')).length, 2);
		assert.ok(logLine(`thread(s) ${worker.threadId} within 200ms`));
		const snapshots = lines.filter((line) => line.includes(`Worker thread ${worker.threadId} at ack timeout:`));
		assert.equal(snapshots.length, 1, lines.join('\n'));
		assert.ok(snapshots[0].includes(`os tid ${worker.osThreadId} state=S`), snapshots[0]);
		assert.ok(/ctxtSwitches=\d+\/\d+/.test(snapshots[0]), snapshots[0]);
		assert.ok(!/ 0x[0-9a-f]+/.test(snapshots[0]), 'register values must not be logged');

		const progress = await waitFor(() => logLine(`Worker thread ${worker.threadId} over the next`), { timeout: 5000 });
		assert.ok(/cpuTicks \+0 ctxtSwitches \+0\/\+\d+ state=S/.test(progress), progress);
		assert.ok(/event loop active \+\d+ms idle \+0ms/.test(progress), progress);
	});

	it('samples a sibling that failed to ack a worker-originated broadcast', async function () {
		if (process.platform !== 'linux') this.skip();
		const blocked = await startFixtureWorker('block');
		started.push(blocked);
		const sender = await startFixtureWorker('acknowledge');
		started.push(sender);
		await waitFor(() => blocked.osThreadId !== undefined);
		const settled = new Promise((resolve) =>
			sender.on('message', (message) => message.type === 'probe-settled' && resolve())
		);
		sender.postMessage({ type: 'send-probe', timeout: 200 });
		await settled;
		const snapshot = await waitFor(() => logLine(`Worker thread ${blocked.threadId} at ack timeout:`));
		assert.ok(snapshot.includes(`os tid ${blocked.osThreadId} state=S`), snapshot);
		assert.ok(!logLine(`Worker thread ${sender.threadId} at ack timeout:`));
	});

	it('reports a worker that exits between the two samples, and one without an OS thread id', async function () {
		if (process.platform !== 'linux') this.skip();
		const worker = await startFixtureWorker('block');
		started.push(worker);
		const { threadId } = worker;
		await waitFor(() => worker.osThreadId !== undefined);
		worker.osThreadId = undefined;
		await broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 100);
		const snapshot = await waitFor(() => logLine(`Worker thread ${threadId} at ack timeout:`));
		assert.ok(snapshot.includes('os thread state unavailable'), snapshot);
		worker.wasShutdown = true;
		await worker.terminate();
		await waitFor(() => !workers.includes(worker));
		await waitFor(() => logLine(`Worker thread ${threadId} exited before its follow-up sample`), { timeout: 5000 });
	});

	it('produces no diagnostics for a worker that acknowledges', async function () {
		const worker = await startFixtureWorker('acknowledge');
		started.push(worker);
		await broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 2000);
		assert.equal(logLine('not acknowledged'), undefined);
		assert.equal(logLine('Worker thread'), undefined);
	});
});
