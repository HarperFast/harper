const assert = require('node:assert');
const { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const {
	parsePidFile,
	readProcessIdentity,
	readProcessIdentityAsync,
	withSpawnPidLock,
	NamedProcessError,
} = require('#src/security/spawnPidFile');
const env = require('#src/utility/environment/environmentManager');

describe('named process PID records and locking', function () {
	this.timeout(30_000);
	let directory;
	let pidFile;
	beforeEach(() => {
		directory = mkdtempSync(join(env.getHdbBasePath(), 'spawn-pid-'));
		pidFile = join(directory, 'child.pid');
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

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
