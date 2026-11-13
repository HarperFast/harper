'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { startWorker, forceWorkerExit, setTerminateTimeout, workers } = require('#src/server/threads/manageThreads');

const FIXTURE = path.join(__dirname, 'forceWorkerExit-fixture.cjs');
const NO_UWS = { HARPER_UWS_UDS: '', HARPER_UWS_HTTP: '' };

let uwsAvailable = true;
try {
	require('uWebSockets.js');
} catch {
	uwsAvailable = false;
}

function startFixture(env, name = 'force-worker-exit-fixture') {
	return new Promise((resolve, reject) => {
		const worker = startWorker(FIXTURE, {
			autoRestart: false,
			name,
			env: { ...process.env, ...NO_UWS, ...env },
		});
		worker.once('error', reject);
		worker.on('message', (message) => {
			if (message?.type === 'fixture-ready') resolve(worker);
		});
	});
}

describe('forceWorkerExit', function () {
	this.timeout(60000);

	afterEach(async function () {
		setTerminateTimeout(10000);
		for (const worker of [...workers]) {
			if (worker.name !== 'force-worker-exit-fixture' && worker.name !== 'job') continue;
			worker.wasShutdown = true;
			await worker.terminate();
		}
	});

	it('asks a worker started with the uWS backend to exit itself', async function () {
		const worker = await startFixture({ HARPER_UWS_UDS: '1', FORCE_EXIT_FIXTURE_HONORS: '1' });
		const exited = once(worker, 'exit');
		await forceWorkerExit(worker);
		assert.deepStrictEqual(await exited, [7]);
	});

	it('terminates a uWS-backend worker that does not exit within the termination timeout', async function () {
		setTerminateTimeout(2000);
		const worker = await startFixture({ HARPER_UWS_HTTP: '1' });
		const exited = once(worker, 'exit');
		const started = Date.now();
		await forceWorkerExit(worker);
		assert.ok(Date.now() - started >= 1900, `terminated after ${Date.now() - started} ms`);
		assert.deepStrictEqual(await exited, [1]);
	});

	it('terminates a worker without the uWS backend at once', async function () {
		const worker = await startFixture({ FORCE_EXIT_FIXTURE_HONORS: '1' });
		const exited = once(worker, 'exit');
		const started = Date.now();
		await forceWorkerExit(worker);
		assert.deepStrictEqual(await exited, [1]);
		assert.ok(Date.now() - started < 1000, `terminated after ${Date.now() - started} ms`);
	});

	it('terminates a job worker at once, even with the uWS backend in its env', async function () {
		const worker = await startFixture({ HARPER_UWS_UDS: '1', FORCE_EXIT_FIXTURE_HONORS: '1' }, 'job');
		const exited = once(worker, 'exit');
		await forceWorkerExit(worker);
		assert.deepStrictEqual(await exited, [1]);
	});

	it('shares one stop between repeated requests', async function () {
		const worker = await startFixture({ HARPER_UWS_UDS: '1', FORCE_EXIT_FIXTURE_HONORS: '1' });
		const first = forceWorkerExit(worker);
		assert.strictEqual(forceWorkerExit(worker), first);
		await first;
	});

	it('settles at once for a uWS-backend worker that has already exited', async function () {
		const worker = await startFixture({ HARPER_UWS_UDS: '1' });
		worker.wasShutdown = true;
		await worker.terminate();
		const started = Date.now();
		await forceWorkerExit(worker);
		assert.ok(Date.now() - started < 1000, `settled after ${Date.now() - started} ms`);
	});
});

describe('a worker holding uWebSockets.js sockets', function () {
	this.timeout(60000);
	before(function () {
		// Node's http client reaches a socketPath through a named pipe on Windows, never uWS's AF_UNIX socket
		if (!uwsAvailable || process.platform === 'win32') this.skip();
	});

	for (const [mode, how] of [
		['self-exit', 'exits itself'],
		['in-flight', 'exits itself with a request in flight'],
		['shutdown-now', 'is stopped by shutdownWorkersNow'],
		['main-exit', 'is stopped before main exits'],
	]) {
		it(`${how} without aborting the process`, async function () {
			const socketPath = path.join(os.tmpdir(), `uws-worker-exit-${process.pid}-${mode}.sock`);
			fs.rmSync(socketPath, { force: true });
			const result = await new Promise((resolve) => {
				execFile(
					process.execPath,
					[...process.execArgv, path.join(__dirname, 'uwsWorkerExit-parent.cjs'), mode, socketPath],
					{ timeout: 45000 },
					(error, stdout, stderr) =>
						resolve({ code: error ? error.code : 0, signal: error ? error.signal : null, stdout, stderr })
				);
			});
			fs.rmSync(socketPath, { force: true });
			assert.deepStrictEqual(
				[result.code, result.signal],
				[0, null],
				`child exited ${result.code}/${result.signal}: ${result.stderr.slice(-2000)}`
			);
			assert.match(result.stdout, /survived/);
		});
	}
});
