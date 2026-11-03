'use strict';

const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { Worker, threadId } = require('node:worker_threads');
const { constants: fsConstants } = require('node:fs');
const fsPromises = require('node:fs/promises');
const { chmod, mkdtemp, mkdir, open, readdir, rm, utimes, writeFile } = fsPromises;
const { syncBuiltinESMExports } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { waitFor } = require('../waitFor.js');
const {
	componentPreparationLockIdentity,
	componentPreparationLockPaths,
	withComponentPreparationLock,
	scanLiveClaims,
	releaseTicket,
	ComponentPreparationLockTimeoutError,
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

// Windows refuses to open a file whose unlink is in progress with EPERM; POSIX has no such state, so the
// refusal is injected. The ESM binding of readFile follows the stub only through syncBuiltinESMExports.
async function withRefusedReads(refuse, run) {
	const { readFile } = fsPromises;
	fsPromises.readFile = async (path, ...rest) => {
		if (await refuse(String(path))) {
			throw Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), { code: 'EPERM' });
		}
		return readFile(path, ...rest);
	};
	syncBuiltinESMExports();
	try {
		return await run();
	} finally {
		fsPromises.readFile = readFile;
		syncBuiltinESMExports();
	}
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

	it('reads a choosing claim refused mid-unlink as removed, and finds the ticket it upgraded to', async () => {
		const { lockRoot, lockName } = componentPreparationLockPaths(join(rootDir, 'unlinking-choosing'));
		await mkdir(lockRoot, { recursive: true, mode: 0o700 });
		const owner = {
			pid: process.pid,
			threadId: 0,
			processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
			token: 'unlinking-token',
			ticket: 3,
		};
		const choosingPath = join(lockRoot, `${lockName}.choosing.${owner.token}.json`);
		const ticketPath = join(lockRoot, `${lockName}.ticket.${owner.ticket}.${owner.token}.json`);
		await writeFile(choosingPath, JSON.stringify(owner));

		let choosingReads = 0;
		const result = await withRefusedReads(
			async (path) => {
				if (path !== choosingPath || choosingReads++ > 0) return false;
				await rm(choosingPath);
				return true;
			},
			() => scanLiveClaims(lockRoot, lockName, {}, undefined, () => writeFile(ticketPath, JSON.stringify(owner)))
		);

		assert.equal(choosingReads, 2, 'the refused read is retried');
		assert.deepStrictEqual(result.choosing, []);
		assert.deepStrictEqual(
			result.tickets.map((ticket) => ticket.token),
			['unlinking-token']
		);
	});

	it('never drops a live ticket whose read is refused', async () => {
		const { lockRoot, lockName } = componentPreparationLockPaths(join(rootDir, 'refused-ticket'));
		await mkdir(lockRoot, { recursive: true, mode: 0o700 });
		const ticketName = `${lockName}.ticket.1.refused-token.json`;
		const ticketPath = join(lockRoot, ticketName);
		await writeFile(
			ticketPath,
			JSON.stringify({
				pid: process.pid,
				threadId: 0,
				processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
				token: 'refused-token',
				ticket: 1,
			})
		);

		let ticketReads = 0;
		const refusedOnce = await withRefusedReads(
			async (path) => path === ticketPath && ticketReads++ === 0,
			() => scanLiveClaims(lockRoot, lockName, {})
		);
		assert.deepStrictEqual(
			refusedOnce.tickets.map((ticket) => ticket.token),
			['refused-token']
		);

		await assert.rejects(
			withRefusedReads(
				async (path) => path === ticketPath,
				() => scanLiveClaims(lockRoot, lockName, {})
			),
			{ code: 'EPERM' },
			'a claim that stays unreadable fails the scan'
		);
		assert.deepStrictEqual(await readdir(lockRoot), [ticketName]);
	});

	it('removes a ticket whose record does not parse, even from a scan that holds no claim', async () => {
		const { lockRoot, lockName } = componentPreparationLockPaths(join(rootDir, 'unparseable-ticket'));
		await mkdir(lockRoot, { recursive: true, mode: 0o700 });
		await writeFile(join(lockRoot, `${lockName}.ticket.1.unparseable.json`), '{');

		const result = await scanLiveClaims(lockRoot, lockName, {});

		assert.deepStrictEqual(result, { choosing: [], tickets: [] });
		assert.deepStrictEqual(await readdir(lockRoot), []);
	});

	describe('a ticket its owner could not remove', () => {
		// Owned by this very thread, so without a released marker it reads as a live holder.
		async function plantLiveTicket(componentDirPath, token) {
			const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
			await mkdir(lockRoot, { recursive: true });
			const ticketPath = join(lockRoot, `${lockName}.ticket.1.${token}.json`);
			await writeFile(
				ticketPath,
				JSON.stringify({
					pid: process.pid,
					threadId,
					processInstanceId: COMPONENT_PREPARATION_PROCESS_INSTANCE_ID,
					token,
					ticket: 1,
				})
			);
			return { lockRoot, lockName, ticketPath };
		}
		const boundedWait = { timeoutMs: 300, renewTimeoutWhileOwnerAlive: false };

		it('blocks every later contender while nothing says it was released', async () => {
			const componentDirPath = join(rootDir, 'stuck-ticket');
			await plantLiveTicket(componentDirPath, 'stuck');

			await assert.rejects(
				withComponentPreparationLock(componentDirPath, async () => {}, boundedWait),
				ComponentPreparationLockTimeoutError
			);
		});

		it('stops blocking once its owner has published the released marker, and both are cleared', async () => {
			const componentDirPath = join(rootDir, 'released-ticket');
			const { lockRoot, lockName } = await plantLiveTicket(componentDirPath, 'released');
			await writeFile(join(lockRoot, `${lockName}.released.released`), '');

			let acquired = false;
			await withComponentPreparationLock(componentDirPath, async () => (acquired = true), boundedWait);

			assert.equal(acquired, true);
			assert.deepStrictEqual(
				(await readdir(lockRoot)).filter((name) => name.startsWith(lockName)),
				[],
				'the stale ticket and its marker are gone, and so is the ticket this acquisition held'
			);
		});

		it('is released by a marker when removing it keeps failing, and the release reports success', async () => {
			const componentDirPath = join(rootDir, 'undeletable-ticket');
			const { lockRoot, lockName, ticketPath } = await plantLiveTicket(componentDirPath, 'undeletable');
			let attempts = 0;

			await releaseTicket(lockRoot, lockName, ticketPath, 'undeletable', async () => {
				attempts++;
				throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
			});

			assert.ok(attempts > 1, 'the removal was retried before falling back to the marker');
			assert.ok((await readdir(lockRoot)).includes(`${lockName}.released.undeletable`));
			let acquired = false;
			await withComponentPreparationLock(componentDirPath, async () => (acquired = true), boundedWait);
			assert.equal(acquired, true, 'and the next contender does not wait behind it');
		});

		// The user-immutable flag: undeletable in a writable directory, as a Windows sharing violation leaves a ticket.
		const undeletable = (filePath, on) => spawnSync('chflags', [on ? 'uchg' : 'nouchg', filePath]);
		const ticketNames = async (lockRoot, lockName) =>
			(await readdir(lockRoot)).filter((name) => name.startsWith(`${lockName}.ticket.`));

		it('publishes the marker from the real release, and clears both once the ticket can go', async function () {
			if (process.platform !== 'darwin') return this.skip();
			const componentDirPath = join(rootDir, 'immutable-ticket');
			const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
			let ticketPath;
			try {
				await withComponentPreparationLock(componentDirPath, async () => {
					ticketPath = join(lockRoot, (await ticketNames(lockRoot, lockName))[0]);
					undeletable(ticketPath, true);
				});
				assert.ok(
					(await readdir(lockRoot)).some((name) => name.startsWith(`${lockName}.released.`)),
					'the release published a marker for the ticket it could not remove'
				);
				let acquired = false;
				await withComponentPreparationLock(componentDirPath, async () => (acquired = true), boundedWait);
				assert.equal(acquired, true, 'and the next holder did not wait behind it');
			} finally {
				if (ticketPath) undeletable(ticketPath, false);
			}

			await withComponentPreparationLock(componentDirPath, async () => {}, boundedWait);
			assert.deepStrictEqual(
				(await readdir(lockRoot)).filter((name) => name.startsWith(lockName)),
				[]
			);
		});

		it('retires the ticket of an acquisition that gave up and could not remove it', async function () {
			if (process.platform !== 'darwin') return this.skip();
			const componentDirPath = join(rootDir, 'immutable-waiter');
			const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
			let releaseHolder;
			const holding = withComponentPreparationLock(
				componentDirPath,
				() => new Promise((resolve) => (releaseHolder = resolve))
			);
			await waitFor(async () => (await ticketNames(lockRoot, lockName).catch(() => [])).length === 1, 5000, 5);
			const [holderTicket] = await ticketNames(lockRoot, lockName);

			const waiting = withComponentPreparationLock(componentDirPath, async () => {}, boundedWait);
			waiting.catch(() => {});
			let waiterTicket;
			await waitFor(
				async () => {
					waiterTicket = (await ticketNames(lockRoot, lockName)).find((name) => name !== holderTicket);
					return Boolean(waiterTicket);
				},
				5000,
				5
			);
			undeletable(join(lockRoot, waiterTicket), true);
			try {
				await assert.rejects(waiting, ComponentPreparationLockTimeoutError);
				const waiterToken = waiterTicket.slice(0, -'.json'.length).split('.').pop();
				assert.ok(
					(await readdir(lockRoot)).includes(`${lockName}.released.${waiterToken}`),
					'the give-up released its ticket through the same marker'
				);
			} finally {
				undeletable(join(lockRoot, waiterTicket), false);
				releaseHolder();
				await holding;
			}
		});

		// A mode its owner cannot read refuses the release's ownership read the way a Windows scanner holding the
		// ticket without read sharing does. Root reads through it, and Windows does not model it this way.
		const readCanBeRefused = () => process.platform !== 'win32' && process.getuid?.() !== 0;

		it('is released even when its record cannot be read at release', async function () {
			if (!readCanBeRefused()) return this.skip();
			const componentDirPath = join(rootDir, 'unreadable-at-release');
			const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);

			await withComponentPreparationLock(componentDirPath, async () => {
				await chmod(join(lockRoot, (await ticketNames(lockRoot, lockName))[0]), 0o000);
			});

			assert.deepStrictEqual(await ticketNames(lockRoot, lockName), [], 'the ticket went');
			let acquired = false;
			await withComponentPreparationLock(componentDirPath, async () => (acquired = true), boundedWait);
			assert.equal(acquired, true);
		});

		it('publishes the marker when its record can be neither read nor removed at release', async function () {
			if (process.platform !== 'darwin') return this.skip();
			const componentDirPath = join(rootDir, 'held-at-release');
			const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
			let ticketPath;
			try {
				await withComponentPreparationLock(componentDirPath, async () => {
					ticketPath = join(lockRoot, (await ticketNames(lockRoot, lockName))[0]);
					await chmod(ticketPath, 0o000);
					undeletable(ticketPath, true);
				});
				assert.ok(
					(await readdir(lockRoot)).some((name) => name.startsWith(`${lockName}.released.`)),
					'the release published a marker for the ticket it could neither read nor remove'
				);
			} finally {
				if (ticketPath) {
					undeletable(ticketPath, false);
					await chmod(ticketPath, 0o600);
				}
			}

			let acquired = false;
			await withComponentPreparationLock(componentDirPath, async () => (acquired = true), boundedWait);
			assert.equal(acquired, true, 'once the ticket can be read again, it reads as released, not live');
		});

		// Node opens every file sharing read, write and delete unless asked for libuv's UV_FS_O_EXLOCK, which shares
		// nothing: the handle of a scanner holding the ticket without read or delete sharing.
		const UV_FS_O_EXLOCK = 0x10000000;

		it('is released through a handle that shares nothing, and the next holder acquires once it closes', async function () {
			if (process.platform !== 'win32') return this.skip();
			const componentDirPath = join(rootDir, 'exclusive-at-release');
			const { lockRoot, lockName } = componentPreparationLockPaths(componentDirPath);
			let handle;
			try {
				await withComponentPreparationLock(componentDirPath, async () => {
					const ticketPath = join(lockRoot, (await ticketNames(lockRoot, lockName))[0]);
					handle = await open(ticketPath, fsConstants.O_RDONLY | UV_FS_O_EXLOCK);
				});
				assert.ok(
					(await readdir(lockRoot)).some((name) => name.startsWith(`${lockName}.released.`)),
					'the release published a marker for the ticket it could neither read nor remove'
				);
			} finally {
				await handle?.close();
			}

			let acquired = false;
			await withComponentPreparationLock(componentDirPath, async () => (acquired = true), boundedWait);
			assert.equal(acquired, true);
		});

		it('still fails when neither the ticket nor a marker can be written', async () => {
			const componentDirPath = join(rootDir, 'unreleasable-ticket');
			const { lockName, ticketPath } = await plantLiveTicket(componentDirPath, 'unreleasable');

			await assert.rejects(
				releaseTicket(join(rootDir, 'no-such-directory'), lockName, ticketPath, 'unreleasable', async () => {
					throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
				}),
				/EPERM/,
				'the removal error is what the caller sees'
			);
		});
	});
});
