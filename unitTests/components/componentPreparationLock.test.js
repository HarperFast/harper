'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { mkdtemp, mkdir, readdir, rm, utimes, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { waitFor } = require('../waitFor.js');
const {
	componentPreparationLockIdentity,
	componentPreparationLockPaths,
	withComponentPreparationLock,
	scanLiveClaims,
	COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
} = require('#src/components/componentPreparationLock');

const lockModulePath = require.resolve('#src/components/componentPreparationLock');

function startLockWorker(componentDirPath, hold = false) {
	return new Worker(
		`const { parentPort, workerData } = require('node:worker_threads');
		Object.defineProperty(process, 'pid', { value: workerData.ownerPid, configurable: true });
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
		{ eval: true, workerData: { componentDirPath, hold, lockModulePath, ownerPid: process.pid } }
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

	it('uses a case-insensitive lock identity on Windows', () => {
		assert.equal(
			componentPreparationLockIdentity('C:\\Components\\Widget', 'win32'),
			componentPreparationLockIdentity('c:\\components\\widget', 'win32')
		);
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
		const releaseErrors = [];

		await assert.rejects(
			withComponentPreparationLock(
				componentDirPath,
				async () => {
					const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
					const claimName = (await readdir(lockRoot)).find((name) => name.startsWith(`${lockName}.ticket.`));
					await writeFile(join(lockRoot, claimName), JSON.stringify({ token: 'stolen' }));
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

	it('does not let multiple contenders race while discarding a dead owner', async () => {
		const componentDirPath = join(rootDir, 'dead-owner-contenders');
		const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
		await mkdir(lockRoot, { recursive: true });
		await writeFile(
			join(lockRoot, `${lockName}.ticket.1.abandoned.json`),
			JSON.stringify({
				pid: process.pid,
				threadId: 0,
				processInstanceId: 'previous-process-instance',
				token: 'abandoned',
				ticket: 1,
			})
		);

		const messages = [[], []];
		const workers = [startLockWorker(componentDirPath, true), startLockWorker(componentDirPath, true)];
		workers.forEach((worker, index) => worker.on('message', (message) => messages[index].push(message)));
		try {
			await waitFor(() => messages.flat().filter((message) => message === 'acquired').length === 1);
			await delay(150);
			assert.equal(messages.flat().filter((message) => message === 'acquired').length, 1);

			const firstIndex = messages.findIndex((workerMessages) => workerMessages.includes('acquired'));
			workers[firstIndex].postMessage('release');
			await waitFor(() => messages.flat().filter((message) => message === 'acquired').length === 2);
			workers[1 - firstIndex].postMessage('release');
			await waitFor(() => messages.flat().filter((message) => message === 'done').length === 2);
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	});

	it('ignores a same-PID owner from an earlier process instance', async () => {
		const componentDirPath = join(rootDir, 'reused-pid');
		const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
		await mkdir(lockRoot, { recursive: true });
		await writeFile(
			join(lockRoot, `${lockName}.ticket.1.old-instance.json`),
			JSON.stringify({
				pid: process.pid,
				threadId: 0,
				processInstanceId: 'earlier-container-start',
				token: 'old-instance',
				ticket: 1,
			})
		);

		let acquired = false;
		await withComponentPreparationLock(componentDirPath, async () => {
			acquired = true;
		});
		assert.equal(acquired, true);
	});

	it('reclaims a lock abandoned by a terminated process', async () => {
		const componentDirPath = join(rootDir, 'abandoned');
		const child = spawn(
			process.execPath,
			[
				'-e',
				`const { withComponentPreparationLock } = require(${JSON.stringify(lockModulePath)});
				withComponentPreparationLock(${JSON.stringify(componentDirPath)}, async () => {
					process.stdout.write('locked\\n');
					setInterval(() => {}, 1000);
				});`,
			],
			{ stdio: ['ignore', 'pipe', 'inherit'] }
		);
		const closePromise = once(child, 'close');
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk));
		try {
			await waitFor(() => output.includes('locked'));
		} finally {
			child.kill();
			await closePromise;
		}

		let acquired = false;
		await withComponentPreparationLock(componentDirPath, async () => {
			acquired = true;
		});
		assert.equal(acquired, true);
	});

	it('reclaims a same-process lock when the owning worker has exited', async () => {
		const componentDirPath = join(rootDir, 'terminated-worker-reclaimed');
		const messages = [];
		const worker = startLockWorker(componentDirPath, true);
		worker.on('message', (message) => messages.push(message));
		await waitFor(() => messages.includes('acquired'));
		await worker.terminate();

		let acquired = false;
		await withComponentPreparationLock(
			componentDirPath,
			async () => {
				acquired = true;
			},
			{ timeoutMs: 100, isOwnerAlive: () => false }
		);
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

	it('treats a zero timeout as a non-blocking lock attempt', async () => {
		const componentDirPath = join(rootDir, 'zero-timeout');
		let releaseHolder;
		let holderStarted;
		const started = new Promise((resolve) => (holderStarted = resolve));
		const holder = withComponentPreparationLock(componentDirPath, async () => {
			holderStarted();
			await new Promise((resolve) => (releaseHolder = resolve));
		});

		try {
			await started;
			await assert.rejects(
				withComponentPreparationLock(componentDirPath, async () => {}, {
					timeoutMs: 0,
					isOwnerAlive: () => true,
				}),
				/Timed out waiting/
			);
		} finally {
			releaseHolder();
			await holder;
		}
	});

	it('does not renew the wait deadline for a foreign-PID owner (the PID may have been recycled)', async () => {
		// A bare kill(pid, 0) on another process only proves *some* process holds that PID, not that
		// it is the original owner — after a hard crash the OS can recycle the PID to an unrelated
		// long-lived process, which must not be able to renew this waiter's deadline forever.
		const componentDirPath = join(rootDir, 'foreign-pid');
		const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
		await mkdir(lockRoot, { recursive: true });

		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
		await once(child, 'spawn');
		try {
			await writeFile(
				join(lockRoot, `${lockName}.ticket.1.foreign-owner.json`),
				JSON.stringify({
					pid: child.pid,
					threadId: 0,
					processInstanceId: 'unrelated-process-instance',
					token: 'foreign-owner',
					ticket: 1,
				})
			);

			await assert.rejects(
				withComponentPreparationLock(componentDirPath, async () => {}, { timeoutMs: 100 }),
				/Timed out waiting.*held by process \d+, thread/
			);
		} finally {
			child.kill();
			await once(child, 'close').catch(() => {});
		}
	});

	it('does not renew the wait deadline when isOwnerAlive rejects', async () => {
		// An unknown owner state must not be treated as license to wait forever — the bounded
		// deadline only fails this waiter, it never steals the lock from a genuinely live owner.
		const componentDirPath = join(rootDir, 'liveness-check-fails');
		const messages = [];
		const worker = startLockWorker(componentDirPath, true);
		worker.on('message', (message) => messages.push(message));
		await waitFor(() => messages.includes('acquired'));
		await worker.terminate();

		await assert.rejects(
			withComponentPreparationLock(componentDirPath, async () => {}, {
				timeoutMs: 100,
				isOwnerAlive: () => {
					throw new Error('liveness check unavailable');
				},
			}),
			/Timed out waiting.*held by process \d+, thread/
		);
	});

	it('sweeps a stale .publishing file left by a crash between writeFile and rename', async () => {
		const componentDirPath = join(rootDir, 'stale-publishing');
		const { lockRoot } = componentPreparationLockPaths(componentDirPath);
		await mkdir(lockRoot, { recursive: true, mode: 0o700 });

		const stalePath = join(lockRoot, '.crashed-token.crashed-uuid.publishing');
		await writeFile(stalePath, JSON.stringify({ pid: 1 }));
		const past = new Date(Date.now() - 120_000);
		await utimes(stalePath, past, past);

		const recentPath = join(lockRoot, '.recent-token.recent-uuid.publishing');
		await writeFile(recentPath, JSON.stringify({ pid: 1 }));

		await withComponentPreparationLock(componentDirPath, async () => {});

		const remaining = await readdir(lockRoot);
		assert.equal(remaining.includes('.crashed-token.crashed-uuid.publishing'), false);
		assert.equal(remaining.includes('.recent-token.recent-uuid.publishing'), true);
	});

	it('does not drop a contender whose choosing claim is read after it upgrades to a ticket', async () => {
		// acquireComponentPreparationLock always durably publishes its ticket before removing its
		// choosing claim, but a scanner can still observe the choosing claim in readdir() and then
		// read it only after that exact upgrade has completed — the choosing file is gone, and
		// without the fallback this contender would vanish from the scan entirely (see the
		// `onEntriesListed` hook below, which forces that interleaving deterministically).
		const { lockRoot, lockName } = componentPreparationLockPaths(join(rootDir, 'race-target'));
		await mkdir(lockRoot, { recursive: true, mode: 0o700 });
		const owner = {
			pid: process.pid,
			threadId: 0,
			processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
			token: 'race-token',
			ticket: 7,
		};
		const choosingPath = join(lockRoot, `${lockName}.choosing.${owner.token}.json`);
		const ticketPath = join(lockRoot, `${lockName}.ticket.${owner.ticket}.${owner.token}.json`);
		await writeFile(choosingPath, JSON.stringify(owner));

		const result = await scanLiveClaims(lockRoot, lockName, {}, undefined, async () => {
			await writeFile(ticketPath, JSON.stringify(owner));
			await rm(choosingPath, { force: true });
		});

		assert.equal(result.choosing.length, 0);
		assert.equal(result.tickets.length, 1);
		assert.equal(result.tickets[0].token, 'race-token');
	});

	it('discards a choosing claim that vanishes with no ticket ever appearing', async () => {
		// The negative case for the same fallback: a choosing claim can also disappear because a
		// concurrent scanner already found its (genuinely dead) owner and removed it. No ticket
		// ever appears under that token, so the claim must still be discarded, not treated as live.
		const { lockRoot, lockName } = componentPreparationLockPaths(join(rootDir, 'no-race-target'));
		await mkdir(lockRoot, { recursive: true, mode: 0o700 });
		const owner = {
			pid: process.pid,
			threadId: 0,
			processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
			token: 'abandoned-token',
		};
		const choosingPath = join(lockRoot, `${lockName}.choosing.${owner.token}.json`);
		await writeFile(choosingPath, JSON.stringify(owner));

		const result = await scanLiveClaims(lockRoot, lockName, {}, undefined, async () => {
			await rm(choosingPath, { force: true });
		});

		assert.equal(result.choosing.length, 0);
		assert.equal(result.tickets.length, 0);
	});
});
