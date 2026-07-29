'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { waitFor } = require('../waitFor.js');
const { withComponentPreparationLock } = require('#src/components/componentPreparationLock');

const lockModulePath = require.resolve('#src/components/componentPreparationLock');

function startLockWorker(componentDirPath, hold = false) {
	return new Worker(
		`const { parentPort, workerData } = require('node:worker_threads');
		const { withComponentPreparationLock } = require(workerData.lockModulePath);
		let release;
		const releasePromise = new Promise((resolve) => release = resolve);
		parentPort.on('message', (message) => {
			if (message === 'release') release();
		});
		parentPort.postMessage('started');
		withComponentPreparationLock(workerData.componentDirPath, async () => {
			parentPort.postMessage('acquired');
			if (workerData.hold) await releasePromise;
		}, { onWait: () => parentPort.postMessage('waiting') }).then(() => parentPort.postMessage('done'), (error) => {
			parentPort.postMessage({ error: error.message });
		});`,
		{ eval: true, workerData: { componentDirPath, hold, lockModulePath } }
	);
}

describe('component preparation lock', () => {
	let rootDir;

	beforeEach(async () => {
		rootDir = await mkdtemp(join(tmpdir(), 'component-preparation-lock-'));
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true, force: true });
	});

	it('serializes the same component directory across worker threads', async () => {
		const componentDirPath = join(rootDir, 'shared');
		const firstMessages = [];
		const firstWorker = startLockWorker(componentDirPath, true);
		firstWorker.on('message', (message) => firstMessages.push(message));
		await waitFor(() => firstMessages.includes('acquired'));

		const messages = [];
		const worker = startLockWorker(componentDirPath);
		worker.on('message', (message) => messages.push(message));
		try {
			await waitFor(() => messages.includes('waiting') || messages.includes('acquired'), {
				timeout: 10000,
				message: `Worker did not contend for the lock: ${JSON.stringify(messages)}`,
			});
			assert.deepStrictEqual(messages.slice(0, 2), ['started', 'waiting']);
		} finally {
			firstWorker.postMessage('release');
			await waitFor(() => firstMessages.includes('done'));
		}
		await waitFor(() => messages.includes('done'));
		assert.deepStrictEqual(messages, ['started', 'waiting', 'acquired', 'done']);
		await firstWorker.terminate();
		await worker.terminate();
	});

	it('does not serialize different component directories', async () => {
		const firstMessages = [];
		const firstWorker = startLockWorker(join(rootDir, 'first'), true);
		firstWorker.on('message', (message) => firstMessages.push(message));
		await waitFor(() => firstMessages.includes('acquired'));

		const messages = [];
		const worker = startLockWorker(join(rootDir, 'second'));
		worker.on('message', (message) => messages.push(message));
		await waitFor(() => messages.includes('done'));
		assert.deepStrictEqual(messages, ['started', 'acquired', 'done']);

		firstWorker.postMessage('release');
		await waitFor(() => firstMessages.includes('done'));
		await firstWorker.terminate();
		await worker.terminate();
	});

	it('releases the lock when preparation fails', async () => {
		const componentDirPath = join(rootDir, 'retry');
		await assert.rejects(
			withComponentPreparationLock(componentDirPath, async () => {
				throw new Error('first preparation failed');
			}),
			/first preparation failed/
		);

		let retried = false;
		await withComponentPreparationLock(componentDirPath, async () => {
			retried = true;
		});
		assert.equal(retried, true);
	});

	it('preserves a preparation failure when releasing the lock also fails', async () => {
		const componentDirPath = join(rootDir, 'release-failure');
		const lockName = createHash('sha256').update(componentDirPath).digest('hex');
		const lockPath = join(rootDir, '.component-preparation-locks', lockName);
		const releaseErrors = [];

		await assert.rejects(
			withComponentPreparationLock(
				componentDirPath,
				async () => {
					await writeFile(lockPath, JSON.stringify({ pid: process.pid, threadId: 0, token: 'stolen' }));
					throw new Error('preparation failed');
				},
				{
					onReleaseError: (error) => {
						releaseErrors.push(error);
						throw new Error('reporting failed');
					},
				}
			),
			/preparation failed/
		);
		assert.equal(releaseErrors.length, 1);
		assert.match(releaseErrors[0].message, /Lost ownership/);
	});

	it('reclaims a lock abandoned by a terminated process', async () => {
		const componentDirPath = join(rootDir, 'abandoned');
		const child = spawn(
			process.execPath,
			[
				'-e',
				`const { withComponentPreparationLock } = require(${JSON.stringify(lockModulePath)});
				withComponentPreparationLock(${JSON.stringify(componentDirPath)}, async () => {
					process.stdout.write('locked\\n', () => process.exit(0));
					await new Promise(() => {});
				});`,
			],
			{ stdio: ['ignore', 'pipe', 'inherit'] }
		);
		const closePromise = once(child, 'close');
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk));
		await waitFor(() => output.includes('locked'));
		await closePromise;

		let acquired = false;
		await withComponentPreparationLock(componentDirPath, async () => {
			acquired = true;
		});
		assert.equal(acquired, true);
	});

	it('bounds the wait for a lock abandoned by a terminated worker thread', async () => {
		const componentDirPath = join(rootDir, 'terminated-worker');
		const messages = [];
		const worker = startLockWorker(componentDirPath, true);
		worker.on('message', (message) => messages.push(message));
		await waitFor(() => messages.includes('acquired'));
		await worker.terminate();

		await assert.rejects(
			withComponentPreparationLock(componentDirPath, async () => {}, { timeoutMs: 100 }),
			/Timed out waiting.*held by process \d+, thread/
		);
	});
});
