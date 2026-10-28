const assert = require('node:assert');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PID_DIR_PATH } = require('../perPidRoot');

function bounded(promise, label, timeout = 30_000) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(label)), timeout))),
	]).finally(() => clearTimeout(timer));
}

describe('future issuance after unsynced WAL loss', function () {
	this.timeout(90_000);
	let root;
	const children = [];
	before(function () {
		// This models POSIX process death and loss of unsynced WAL, not a physical power cut.
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || process.platform === 'win32') this.skip();
	});
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(PID_DIR_PATH, 'issuance-wal-loss-'));
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
			await bounded(child.exited, 'issuance child did not exit', 10_000);
		}
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	function start(mode) {
		const child = fork(path.join(__dirname, 'fixtures/issuanceRecovery.cjs'), [mode, root], {
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			env: { ...process.env, HARPER_NO_FLUSH_ON_EXIT: '1' },
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8192)));
		const exited = new Promise((resolve) => {
			child.once('exit', (code, signal) => resolve({ code, signal }));
			child.once('error', (error) => resolve({ error }));
		});
		const reply = bounded(
			new Promise((resolve, reject) => {
				child.on('message', (message) => {
					if (message.type === 'issuance-result') resolve(message);
				});
				child.once('error', reject);
				child.once('exit', (code, signal) => reject(new Error(`issuance child exited ${code}/${signal}: ${stderr}`)));
			}),
			`issuance child never replied (${mode})`
		);
		const entry = { process: child, exited, reply };
		children.push(entry);
		return entry;
	}

	it('recovers above a peer-observed key after losing the unflushed WAL', async () => {
		const issuing = start('issue');
		const observed = await issuing.reply;
		assert.deepStrictEqual(observed.initialSstFiles, [], 'the fixture starts with no data in SST files');
		assert.ok(observed.ceiling >= observed.key);
		issuing.process.kill('SIGKILL');
		await bounded(issuing.exited, 'issuing child did not terminate', 10_000);
		const walFiles = (await fs.readdir(root)).filter((name) => /^\d+\.log$/.test(name));
		assert.ok(walFiles.length, 'the fixture must contain an engine WAL');
		for (const name of walFiles) await fs.truncate(path.join(root, name), 0);
		const recovery = start('recover');
		const recovered = await recovery.reply;
		assert.ok(Date.now() < observed.key, 'recovery must happen before clock catch-up');
		assert.ok(recovered.recoveredCeiling >= observed.ceiling, 'coverage survives loss of the unsynced WAL');
		assert.ok(recovered.key > observed.ceiling, 'recovery cannot reuse a key already observed by a peer');
		const result = await bounded(recovery.exited, 'recovery child did not exit');
		assert.strictEqual(result.code, 0);
	});
});
