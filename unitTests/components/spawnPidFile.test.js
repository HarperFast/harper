const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const {
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	renameSync,
	existsSync,
	openSync,
	closeSync,
	constants,
} = require('node:fs');
const { join } = require('node:path');
const {
	parsePidFile,
	readProcessIdentity,
	readProcessIdentityAsync,
	withSpawnPidLock,
	tryWithSpawnPidLock,
	isPreviousBoot,
	writePidRecord,
	NamedProcessError,
} = require('#src/security/spawnPidFile');
const env = require('#src/utility/environment/environmentManager');
const { waitFor } = require('../waitFor.js');

describe('named process PID records and locking', function () {
	this.timeout(process.platform === 'win32' ? 90_000 : 30_000);
	let directory;
	let pidFile;
	beforeEach(() => {
		directory = mkdtempSync(join(env.getHdbBasePath(), 'spawn-pid-'));
		pidFile = join(directory, 'child.pid');
	});
	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it('accepts a complete identity and a legacy record with no identity', () => {
		assert.deepStrictEqual(parsePidFile('42\n3\nlinux:boot:123'), { pid: 42, version: 3, identity: 'linux:boot:123' });
		assert.deepStrictEqual(parsePidFile('42'), { pid: 42, version: 0, identity: undefined });
	});
	it('refuses zero, negative, fractional, truncated, and unsafe pid values', () => {
		for (const pid of ['0', '-1', '42.5', '42abc', '9007199254740992', '']) {
			assert.strictEqual(parsePidFile(`${pid}\n3\nbirth`).pid, 0);
		}
	});
	it('reads the same live process identity synchronously and asynchronously', async () => {
		const identity = readProcessIdentity(process.pid);
		assert(identity.identity);
		assert.deepStrictEqual(await readProcessIdentityAsync(process.pid), identity);
	});
	it('distinguishes the current Linux boot from a recorded older boot', () => {
		const identity = readProcessIdentity(process.pid).identity;
		assert.strictEqual(isPreviousBoot(identity), false);
		assert.strictEqual(isPreviousBoot('linux:previous-boot:1:1'), process.platform === 'linux');
	});
	it('publishes a complete record and removes its staging file', () => {
		const record = `${process.pid}\n3\n${readProcessIdentity(process.pid).identity}`;
		writePidRecord(pidFile, record);
		assert.strictEqual(readFileSync(pidFile, 'utf8'), record);
		assert.deepStrictEqual(readdirSync(directory), ['child.pid']);
	});
	it('cleans up a failed publication without deleting the existing target', () => {
		mkdirSync(pidFile);
		assert.throws(() => writePidRecord(pidFile, 'record'));
		assert.deepStrictEqual(readdirSync(directory), ['child.pid']);
		assert.deepStrictEqual(readdirSync(pidFile), []);
	});
	it('confirms that a reaped child is absent synchronously and asynchronously', async () => {
		const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
		await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
		assert.strictEqual(readProcessIdentity(child.pid), null);
		assert.strictEqual(await readProcessIdentityAsync(child.pid), null);
	});
	it('rejects unsafe probe pids before any operating-system operation', async () => {
		for (const pid of [0, -1, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => readProcessIdentity(pid), NamedProcessError);
			await assert.rejects(readProcessIdentityAsync(pid), NamedProcessError);
		}
	});
	it('releases its claim after both success and callback failure', () => {
		assert.strictEqual(
			withSpawnPidLock(pidFile, () => 42),
			42
		);
		assert.throws(
			() =>
				withSpawnPidLock(pidFile, () => {
					throw new Error('callback failed');
				}),
			/callback failed/
		);
		assert.deepStrictEqual(readdirSync(`${pidFile}.locks`), []);
	});
	it('skips busy cleanup without waiting or probing foreign claims', () => {
		withSpawnPidLock(pidFile, () => {
			const foreign = join(`${pidFile}.locks`, 'foreign.json');
			writeFileSync(
				foreign,
				JSON.stringify({ pid: 2147483648, identity: 'unreadable-foreign', token: 'foreign', ticket: 1 })
			);
			try {
				assert.strictEqual(
					tryWithSpawnPidLock(pidFile, () => assert.fail('contended cleanup')),
					false
				);
				assert(existsSync(foreign));
			} finally {
				rmSync(foreign);
			}
		});
		let cleaned = false;
		assert.strictEqual(
			tryWithSpawnPidLock(pidFile, () => {
				cleaned = true;
			}),
			true
		);
		assert(cleaned);
	});
	for (const failCallback of [false, true]) {
		it(`preserves the callback outcome when both release paths fail (${failCallback})`, function () {
			// A file in place of a parent directory reliably produces ENOTDIR on POSIX.
			if (process.platform === 'win32') return this.skip();
			const failures = [];
			const run = () =>
				withSpawnPidLock(
					pidFile,
					() => {
						const lockDir = `${pidFile}.locks`;
						renameSync(lockDir, join(directory, 'moved-locks'));
						writeFileSync(lockDir, 'not a directory');
						if (failCallback) spawn(null);
						return 42;
					},
					undefined,
					(error) => failures.push(error)
				);
			if (failCallback) assert.throws(run, (error) => error.code === 'ERR_INVALID_ARG_TYPE');
			else assert.strictEqual(run(), 42);
			assert.strictEqual(failures.length, 1);
			assert.strictEqual(failures[0].code, 'ENOTDIR');
		});
	}
	it('honors a release marker before reading its retired claim', () => {
		const lockDir = `${pidFile}.locks`;
		mkdirSync(lockDir);
		writeFileSync(join(lockDir, 'retired.json'), 'unreadable claim');
		writeFileSync(join(lockDir, 'retired.released'), '');
		assert.strictEqual(
			withSpawnPidLock(pidFile, () => 42),
			42
		);
		assert.deepStrictEqual(readdirSync(lockDir), []);
	});
	it('returns the callback result when a Windows scanner prevents claim removal', function () {
		if (process.platform !== 'win32') return this.skip();
		let handle;
		try {
			assert.strictEqual(
				withSpawnPidLock(pidFile, () => {
					const claim = readdirSync(`${pidFile}.locks`).find((name) => name.endsWith('.json'));
					handle = openSync(join(`${pidFile}.locks`, claim), constants.O_RDONLY | 0x10000000);
					return 42;
				}),
				42
			);
			assert(readdirSync(`${pidFile}.locks`).some((name) => name.endsWith('.released')));
			assert.strictEqual(
				withSpawnPidLock(pidFile, () => 43),
				43
			);
		} finally {
			if (handle !== undefined) closeSync(handle);
		}
		withSpawnPidLock(pidFile, () => {});
		assert.deepStrictEqual(readdirSync(`${pidFile}.locks`), []);
	});
	it('renews its wait deadline as preceding holders leave a healthy queue', async () => {
		const lockDir = `${pidFile}.locks`;
		mkdirSync(lockDir);
		for (const ticket of [1, 2]) {
			writeFileSync(
				join(lockDir, `holder-${ticket}.json`),
				JSON.stringify({
					pid: process.pid,
					identity: readProcessIdentity(process.pid).identity,
					token: `holder-${ticket}`,
					ticket,
				})
			);
		}
		const worker = new Worker(join(__dirname, 'fixtures/named-process/spawn-lock-worker.cjs'), {
			workerData: { pidFile, timeoutMs: 2000, noServerStart: true },
		});
		const result = once(worker, 'message', {
			signal: AbortSignal.timeout(process.platform === 'win32' ? 60_000 : 10_000),
		});
		result.catch(() => {});
		try {
			await waitFor(
				() =>
					readdirSync(lockDir).some(
						(name) =>
							name.endsWith('.json') &&
							!name.startsWith('holder-') &&
							JSON.parse(readFileSync(join(lockDir, name), 'utf8')).ticket === 3
					),
				process.platform === 'win32' ? 45_000 : 5000
			);
			await delay(1200);
			rmSync(join(lockDir, 'holder-1.json'));
			await delay(1200);
			rmSync(join(lockDir, 'holder-2.json'));
			const [message] = await result;
			assert.strictEqual(message.acquired, true, message.error);
			assert(message.elapsedMs >= 2000);
		} finally {
			await worker.terminate();
		}
	});
	it('times out a stalled predecessor while new choosing claims keep arriving', async () => {
		const lockDir = `${pidFile}.locks`;
		mkdirSync(lockDir);
		const identity = readProcessIdentity(process.pid).identity;
		writeFileSync(
			join(lockDir, 'holder.json'),
			JSON.stringify({ pid: process.pid, identity, token: 'holder', ticket: 1 })
		);
		const worker = new Worker(join(__dirname, 'fixtures/named-process/spawn-lock-worker.cjs'), {
			workerData: { pidFile, timeoutMs: 1000, noServerStart: true },
		});
		const result = once(worker, 'message', {
			signal: AbortSignal.timeout(process.platform === 'win32' ? 60_000 : 10_000),
		});
		result.catch(() => {});
		let arrivals;
		let stopArrivals;
		let arrivalsStopped = false;
		let count = 0;
		try {
			await waitFor(
				() =>
					readdirSync(lockDir).some(
						(name) =>
							name.endsWith('.json') &&
							name !== 'holder.json' &&
							JSON.parse(readFileSync(join(lockDir, name), 'utf8')).ticket === 2
					),
				process.platform === 'win32' ? 45_000 : 5000
			);
			arrivals = setInterval(() => {
				const token = `arrival-${++count}`;
				const staging = join(lockDir, `${token}.tmp`);
				writeFileSync(staging, JSON.stringify({ pid: process.pid, identity, token }));
				renameSync(staging, join(lockDir, `${token}.json`));
			}, 100);
			stopArrivals = setTimeout(() => {
				arrivalsStopped = true;
				clearInterval(arrivals);
			}, 3000);
			const [message] = await result;
			assert.match(message.error, /Timed out/);
			assert(count >= 3, 'the waiter observed repeated new arrivals');
			assert.strictEqual(arrivalsStopped, false, 'the stalled wait must end before arrivals stop');
		} finally {
			clearInterval(arrivals);
			clearTimeout(stopArrivals);
			await worker.terminate();
		}
	});
	it('waits for a live owner without stealing its claim', () => {
		withSpawnPidLock(pidFile, () => {
			const before = readdirSync(`${pidFile}.locks`);
			assert.throws(() => withSpawnPidLock(pidFile, () => assert.fail('two lock holders'), 20), /Timed out/);
			assert.deepStrictEqual(readdirSync(`${pidFile}.locks`), before);
		});
	});
	it('reclaims only the unique claim of an owner with a different lifetime', () => {
		mkdirSync(`${pidFile}.locks`);
		const claim = join(`${pidFile}.locks`, 'stale.json');
		writeFileSync(claim, JSON.stringify({ pid: process.pid, identity: 'previous-process', token: 'stale', ticket: 1 }));
		withSpawnPidLock(pidFile, () => assert.strictEqual(existsSync(claim), false));
	});
	it('preserves an unreadable claim and refuses to enter the critical section', () => {
		mkdirSync(`${pidFile}.locks`);
		const claim = join(`${pidFile}.locks`, 'unreadable.json');
		mkdirSync(claim);
		assert.throws(() => withSpawnPidLock(pidFile, () => assert.fail('unknown owner must block')));
		assert.strictEqual(existsSync(claim), true);
		assert.deepStrictEqual(readdirSync(`${pidFile}.locks`), ['unreadable.json']);
	});
});
