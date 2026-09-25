'use strict';

const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const harperLogger = require('#src/utility/logging/harper_logger');
const {
	startWorker,
	broadcastWithAcknowledgement,
	broadcastWithStrictAcknowledgement,
	onMessageFromWorkers,
	workers,
} = require('#js/server/threads/manageThreads');
const { pinLogConfig } = require('../../logConfigFixture.js');
const { waitFor } = require('../../waitFor.js');
const { sendItcEvent } = require('#js/server/threads/itc');
const {
	claimDatabaseDropPreparation,
	databaseDropPrepared,
	releaseDatabaseDropPreparation,
} = require('#src/resources/databaseDropPreparation');

const FIXTURE = path.join(__dirname, 'stuckWorker-fixture.cjs');

function startFixtureWorker(mode, name = 'http') {
	return new Promise((resolve, reject) => {
		startWorker(FIXTURE, {
			name,
			workerIndex: 0,
			threadCount: 2,
			autoRestart: false,
			argv: [`--${mode}`],
			onStarted(worker) {
				worker.on('message', (message) => {
					if (message.type === 'fixture-ready') {
						worker.databaseDropPreparations = message.databaseDropPreparations;
						resolve(worker);
					}
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

	it('reports a spinning worker as consuming CPU', async function () {
		if (process.platform !== 'linux') this.skip();
		const worker = await startFixtureWorker('spin');
		started.push(worker);
		await waitFor(() => worker.osThreadId !== undefined);
		await broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 200);
		const progress = await waitFor(() => logLine(`Worker thread ${worker.threadId} over the next`), { timeout: 5000 });
		assert.ok(/cpuTicks \+[1-9]\d* /.test(progress), progress);
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

	it('rejects a strict broadcast when a worker reports preparation failure', async function () {
		const worker = await startFixtureWorker('reject');
		started.push(worker);
		await assert.rejects(broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000), (error) => {
			assert(error instanceof AggregateError);
			assert.match(error.errors[0].message, /could not prepare for the schema change: fixture preparation failed/);
			return true;
		});
	});

	it('preserves a shared worker conflict on a strict broadcast', async function () {
		const worker = await startFixtureWorker('reject-conflict');
		started.push(worker);
		await assert.rejects(broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000), (error) => {
			assert(error instanceof AggregateError);
			assert.strictEqual(error.name, 'DatabaseDroppingError');
			assert.strictEqual(error.code, 'DATABASE_DROP_IN_PROGRESS');
			assert.strictEqual(error.statusCode, 409);
			assert.strictEqual(error.errors[0].name, 'DatabaseDroppingError');
			assert.strictEqual(error.errors[0].code, 'DATABASE_DROP_IN_PROGRESS');
			assert.strictEqual(error.errors[0].statusCode, 409);
			return true;
		});
	});

	it('preserves retryable worker failures on a strict broadcast', async function () {
		const worker = await startFixtureWorker('reject-retryable');
		started.push(worker);
		await assert.rejects(broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000), (error) => {
			assert(error instanceof AggregateError);
			assert.strictEqual(error.name, 'DatabaseDrainTimeoutError');
			assert.strictEqual(error.code, 'DATABASE_DRAIN_TIMEOUT');
			assert.strictEqual(error.statusCode, 503);
			assert.strictEqual(error.retryable, true);
			assert.strictEqual(error.errors[0].retryable, true);
			return true;
		});
	});

	it('rejects a strict broadcast when a worker exits before acknowledging', async function () {
		const worker = await startFixtureWorker('exit');
		started.push(worker);
		await assert.rejects(broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000), (error) => {
			assert(error instanceof AggregateError);
			assert.match(error.errors[0].message, /exited before acknowledging preparation/);
			return true;
		});
	});

	it('does not inherit best-effort exit handling from an earlier broadcast', async function () {
		const worker = await startFixtureWorker('ack-then-exit');
		started.push(worker);
		await broadcastWithAcknowledgement({ type: 'diagnostic-probe' }, 2000);
		await assert.rejects(broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000), (error) => {
			assert(error instanceof AggregateError);
			assert.match(error.errors[0].message, /exited before acknowledging preparation/);
			return true;
		});
	});

	it('includes job workers when destructive preparation requests it', async function () {
		const worker = await startFixtureWorker('reject', 'job');
		started.push(worker);
		await assert.rejects(broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000, true), (error) => {
			assert(error instanceof AggregateError);
			assert.match(error.errors[0].message, /fixture preparation failed/);
			return true;
		});
	});

	it('accepts a job worker that closes normally before acknowledging preparation', async function () {
		const worker = await startFixtureWorker('exit', 'job');
		started.push(worker);
		await broadcastWithStrictAcknowledgement({ type: 'diagnostic-probe' }, 2000, true);
	});

	it('includes job workers when destructive completion requests it', async function () {
		const worker = await startFixtureWorker('report-acknowledge', 'job');
		started.push(worker);
		const received = new Promise((resolve) =>
			worker.on('message', (message) => message.type === 'fixture-received' && resolve(message))
		);
		await sendItcEvent({ type: 'diagnostic-probe', message: {} }, true);
		assert.ok(await received);
	});

	it('passes active database-drop fences to workers started during preparation', async function () {
		const databaseName = 'worker-start-during-drop';
		const preparationId = 'worker-start-during-drop-test';
		claimDatabaseDropPreparation(databaseName, preparationId);
		try {
			const worker = await startFixtureWorker('acknowledge');
			started.push(worker);
			assert.deepStrictEqual(worker.databaseDropPreparations, [
				[databaseName, { id: preparationId, ownerThreadId: 0, databaseName }],
			]);
		} finally {
			releaseDatabaseDropPreparation(databaseName, preparationId);
		}
	});

	it('does not inherit a fence whose owner is absent from the new worker topology', async function () {
		const databaseName = 'worker-start-after-drop-owner-exit';
		const preparationId = 'worker-start-after-drop-owner-exit-test';
		claimDatabaseDropPreparation(databaseName, preparationId, 999_999);
		try {
			const worker = await startFixtureWorker('acknowledge');
			started.push(worker);
			assert.deepStrictEqual(worker.databaseDropPreparations, []);
		} finally {
			releaseDatabaseDropPreparation(databaseName, preparationId);
		}
	});

	it('releases a database-drop fence when its owning worker exits', async function () {
		const worker = await startFixtureWorker('acknowledge');
		started.push(worker);
		const databaseName = 'worker-exits-during-drop';
		const preparationId = 'worker-exits-during-drop-test';
		claimDatabaseDropPreparation(databaseName, preparationId, worker.threadId);
		assert.strictEqual(databaseDropPrepared(databaseName), true);

		worker.wasShutdown = true;
		await worker.terminate();
		started.pop();
		await waitFor(() => !databaseDropPrepared(databaseName));

		assert.strictEqual(claimDatabaseDropPreparation(databaseName, 'retry-after-worker-exit'), true);
		releaseDatabaseDropPreparation(databaseName, 'retry-after-worker-exit');
	});
});
