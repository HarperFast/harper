const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { scopedImport } = require('#src/security/jsLoader');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { readProcessIdentity } = require('#src/security/spawnPidFile');
const { waitFor } = require('../waitFor.js');

const fixtures = join(__dirname, 'fixtures', 'named-process');
const childPath = join(fixtures, 'spawn-child.cjs');

describe('constrained spawn process identity', function () {
	this.timeout(process.platform === 'win32' ? 90_000 : 30_000);
	let api;
	let name;
	let pidFile;
	let sequence = 0;
	const children = [];
	const wrappers = [];
	const workers = [];
	const workerPids = new Set();

	before(async () => {
		api = await scopedImport(join(fixtures, 'spawn-api.mjs'), { mode: 'vm-current-context', allowedPath: fixtures });
	});
	beforeEach(() => {
		name = `pid-identity-${process.pid}-${++sequence}`;
		const pidDir = join(env.getHdbBasePath(), 'pids');
		mkdirSync(pidDir, { recursive: true });
		pidFile = join(pidDir, `${name}.pid`);
	});
	afterEach(async () => {
		for (const pid of workerPids) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {}
		}
		workerPids.clear();
		for (const wrapper of wrappers.splice(0)) wrapper.unref();
		for (const child of children.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
			child.kill('SIGKILL');
			await exited;
		}
		await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
		if (pidFile) {
			rmSync(pidFile, { force: true });
			rmSync(`${pidFile}.locks`, { recursive: true, force: true });
		}
	});

	function fork(options = {}) {
		const child = api.fork(childPath, [], { name, stdio: 'ignore', ...options });
		if (typeof child.disconnect === 'function') children.push(child);
		else wrappers.push(child);
		return child;
	}
	it('preserves the native error code for invalid fork arguments', () => {
		assert.throws(
			() => api.fork(null, [], { name, stdio: 'ignore' }),
			(error) => error.code === 'ERR_INVALID_ARG_TYPE'
		);
	});
	it('retires a prior Linux boot before probing an inaccessible PID', function () {
		if (process.platform !== 'linux') return this.skip();
		writeFileSync(pidFile, '2147483648\n0\nlinux:previous-boot:2147483648:1');
		assert(fork().pid);
	});

	for (const version of [undefined, 2]) {
		it(`replaces a legacy file without adopting or signaling its live pid (version ${version})`, async () => {
			const stranger = spawn(process.execPath, [childPath], { stdio: 'ignore' });
			children.push(stranger);
			writeFileSync(pidFile, `${stranger.pid}\n1`);
			const child = fork({ version });
			assert.notStrictEqual(child.pid, stranger.pid, 'must not adopt an unidentified live pid');
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.strictEqual(stranger.exitCode, null);
			assert.strictEqual(stranger.signalCode, null, 'must not signal an unidentified live pid');
		});
	}

	it('reuses a matching fork and persists its birth identity', () => {
		const child = fork({ version: 3 });
		const wrapper = fork({ version: 3 });
		assert.strictEqual(wrapper.pid, child.pid);
		const lines = readFileSync(pidFile, 'utf8').trim().split('\n');
		assert.strictEqual(lines[0], String(child.pid));
		assert.strictEqual(lines[1], '3');
		assert(lines[2], 'the pid file must identify the process lifetime');
	});

	it('replaces a live pid with a different recorded identity without signaling it', async () => {
		const child = fork({ version: 1 });
		const lines = readFileSync(pidFile, 'utf8').trim().split('\n');
		lines[2] = 'invalid-process-identity';
		writeFileSync(pidFile, lines.join('\n'));
		const replacement = fork({ version: 2 });
		assert.notStrictEqual(replacement.pid, child.pid);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.strictEqual(child.signalCode, null);
	});

	it('replaces an identified child when its requested version changes', async () => {
		const child = fork({ version: 1 });
		const replacement = fork({ version: 2 });
		assert.notStrictEqual(replacement.pid, child.pid);
		await waitFor(() => child.signalCode === 'SIGTERM', 5000);
	});
	async function prepareWorker() {
		const worker = new Worker(join(fixtures, 'spawn-worker.cjs'), { workerData: { name, noServerStart: true } });
		workers.push(worker);
		await new Promise((resolve, reject) => {
			worker.on('message', (message) => message.ready && resolve());
			worker.once('error', reject);
		});
		return worker;
	}
	function startWorker(worker) {
		return new Promise((resolve, reject) => {
			worker.on('message', (message) => {
				if (message.spawnedPid) {
					workerPids.add(message.spawnedPid);
					resolve(message.spawnedPid);
				}
			});
			worker.once('error', reject);
			worker.postMessage('spawn');
		});
	}
	function zombie(pid) {
		if (process.platform === 'linux') {
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
				return stat[stat.lastIndexOf(')') + 2] === 'Z';
			} catch {
				return false;
			}
		}
		return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' })
			.trim()
			.startsWith('Z');
	}

	it('does not signal a process whose pid no longer belongs to its wrapper', () => {
		const original = fork();
		const wrapper = fork();
		const stranger = spawn(process.execPath, [childPath], { stdio: 'ignore' });
		children.push(stranger);
		wrapper.pid = stranger.pid;
		assert.strictEqual(wrapper.kill('SIGKILL'), false);
		assert.strictEqual(original.signalCode, null);
		assert.strictEqual(stranger.signalCode, null);
	});

	it('emits exit once when the identified child exits', async () => {
		const child = fork();
		const wrapper = fork();
		let exits = 0;
		wrapper.on('exit', () => exits++);
		child.kill('SIGKILL');
		await waitFor(() => exits === 1, 10_000);
		await new Promise((resolve) => setTimeout(resolve, 1100));
		assert.strictEqual(exits, 1);
	});

	it('preserves a newer record when an older child exits', async () => {
		const child = fork({ version: 1 });
		const next = fork({ version: 2 });
		const record = readFileSync(pidFile, 'utf8');
		await waitFor(() => child.signalCode !== null, 5000);
		assert.strictEqual(readFileSync(pidFile, 'utf8'), record);
		assert.strictEqual(Number(record.split('\n')[0]), next.pid);
	});

	it('reuses a shebang script by lifetime rather than command line', function () {
		if (process.platform === 'win32') return this.skip();
		const script = join(env.getHdbBasePath(), `${name}.sh`);
		writeFileSync(script, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
		const allowed = env.get(CONFIG_PARAMS.APPLICATIONS_ALLOWEDSPAWNCOMMANDS);
		try {
			env.setProperty(CONFIG_PARAMS.APPLICATIONS_ALLOWEDSPAWNCOMMANDS, [script]);
			const child = api.spawn(script, [], { name, stdio: 'ignore' });
			children.push(child);
			const wrapper = api.spawn(script, [], { name, stdio: 'ignore' });
			wrappers.push(wrapper);
			assert.strictEqual(wrapper.pid, child.pid);
		} finally {
			env.setProperty(CONFIG_PARAMS.APPLICATIONS_ALLOWEDSPAWNCOMMANDS, allowed);
			rmSync(script, { force: true });
		}
	});

	it('rejects a Linux thread id even though signal zero succeeds', function () {
		if (process.platform !== 'linux') return this.skip();
		const tid = readdirSync(`/proc/${process.pid}/task`)
			.map(Number)
			.find((pid) => pid !== process.pid);
		assert(tid);
		assert.doesNotThrow(() => process.kill(tid, 0));
		writeFileSync(pidFile, `${tid}\n1\n${readProcessIdentity(process.pid).identity}`);
		assert.notStrictEqual(fork({ version: 2 }).pid, tid);
	});

	it('preserves an unreadable PID record and refuses to spawn', function () {
		if (process.platform === 'win32' || process.getuid?.() === 0) return this.skip();
		const child = fork();
		const record = readFileSync(pidFile, 'utf8');
		chmodSync(pidFile, 0);
		try {
			assert.throws(() => fork(), /Could not spawn named process/);
		} finally {
			chmodSync(pidFile, 0o600);
		}
		assert.strictEqual(readFileSync(pidFile, 'utf8'), record);
		assert.strictEqual(child.signalCode, null);
	});

	it('starts only one child when eight workers replace a stale record', async () => {
		writeFileSync(pidFile, `${process.pid}\n0`);
		const pool = await Promise.all(Array.from({ length: 8 }, prepareWorker));
		const pids = await Promise.all(pool.map(startWorker));
		assert.strictEqual(new Set(pids).size, 1);
		assert.notStrictEqual(pids[0], process.pid);
		const wrapper = fork();
		assert.strictEqual(wrapper.pid, pids[0]);
		process.kill(pids[0], 'SIGKILL');
		await waitFor(() => readProcessIdentity(pids[0]) === null, 10_000);
	});

	for (const observeWrapper of [false, true]) {
		it(`replaces an orphaned zombie and reports wrapper exit (${observeWrapper})`, async function () {
			if (process.platform !== 'linux' && process.platform !== 'darwin') return this.skip();
			const worker = await prepareWorker();
			const pid = await startWorker(worker);
			let exited = false;
			if (observeWrapper) {
				const wrapper = fork();
				assert.strictEqual(wrapper.pid, pid);
				wrapper.once('exit', () => {
					exited = true;
				});
			}
			await worker.terminate();
			process.kill(pid, 'SIGKILL');
			await waitFor(() => zombie(pid), 5000);
			assert.doesNotThrow(() => process.kill(pid, 0));
			if (observeWrapper) await waitFor(() => exited, 10_000);
			const next = fork();
			assert.notStrictEqual(next.pid, pid);
		});
	}
});
