'use strict';

/**
 * Transient materialization of SSH deploy keys (harper-pro#581).
 *
 * git/ssh needs a key *file*, but the key is now sealed at rest as an `enc:v1:` envelope (Pro's
 * `add_ssh_key`). `materializeGitSSH` decrypts it into a fresh 0700 temp dir as a 0600 file and
 * repoints the ssh config's `IdentityFile` at that copy for exactly the lifetime of one spawn —
 * the same decrypt-to-transient-file shape as the per-deploy `.npmrc` (#1717).
 *
 * The things that actually matter here, and that these tests pin:
 *  - the plaintext exists only inside the temp dir, at 0600, in a 0700 dir
 *  - it is removed when the spawn settles — including when the command FAILS
 *  - an undecryptable key (no custody, foreign cluster key, tampered envelope) is skipped and
 *    logged, not fatal: a deploy that doesn't need that key still works, one that does gets the
 *    normal SSH auth error
 *  - no log or error message ever carries key material or the envelope
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { materializeGitSSH, nonInteractiveSpawn, rewriteSshConfigPaths } = require('#src/components/Application');
const secretDecryptor = require('#src/resources/secretDecryptor');
const { encryptEnvelope, decryptEnvelope, fingerprintOf } = require('#src/utility/secretEnvelope');
// CJS interop hands back the module namespace, which is the very object Application.ts's default
// import resolves to — so stubbing a level here is what the code under test sees.
const logger = require('#src/utility/logging/harper_logger');

const ENC_PREFIX = 'enc:v1:';
const KEY_MATERIAL = '-----BEGIN OPENSSH PRIVATE KEY-----\nc3NoLWtleS1tYXRlcmlhbA\n-----END OPENSSH PRIVATE KEY-----\n';

function makeKeypair() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	return { privateKey, publicKey, kid: fingerprintOf(publicKey) };
}

// The decryptor Pro registers: strip the marker, unwrap, AES-GCM decrypt.
function decryptorFor({ privateKey, kid }) {
	return (value) => decryptEnvelope(value.slice(ENC_PREFIX.length), privateKey, kid);
}

const tempSSHDirs = () => fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('harper-ssh-'));

describe('materializeGitSSH', () => {
	let rootDir;
	let sshDir;
	let keypair;
	let logged;
	let originalError;
	let originalWarn;

	function writeSSHDir(keyFiles) {
		fs.mkdirSync(sshDir, { recursive: true });
		const configBlocks = [];
		for (const [name, contents] of Object.entries(keyFiles)) {
			const keyPath = path.join(sshDir, `${name}.key`);
			fs.writeFileSync(keyPath, contents, { mode: 0o600 });
			configBlocks.push(
				`#${name}\nHost gh-${name}\n\tHostName example.com\n\tUser git\n\tIdentityFile ${keyPath}\n\tIdentitiesOnly yes`
			);
		}
		fs.writeFileSync(path.join(sshDir, 'config'), configBlocks.join('\n'));
		fs.writeFileSync(path.join(sshDir, 'known_hosts'), '');
	}

	const seal = (plaintext, kp = keypair) => ENC_PREFIX + encryptEnvelope(plaintext, kp.publicKey, kp.kid);

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ssh-test-'));
		sshDir = path.join(rootDir, 'ssh');
		env.setProperty(terms.CONFIG_PARAMS.ROOTPATH, rootDir);
		keypair = makeKeypair();

		logged = [];
		originalError = logger.error;
		originalWarn = logger.warn;
		logger.error = (...args) => logged.push(args.join(' '));
		logger.warn = (...args) => logged.push(args.join(' '));
	});

	afterEach(() => {
		logger.error = originalError;
		logger.warn = originalWarn;
		secretDecryptor.clearSecretDecryptor();
		fs.rmSync(rootDir, { recursive: true, force: true });
		for (const leftover of tempSSHDirs()) {
			fs.rmSync(path.join(os.tmpdir(), leftover), { recursive: true, force: true });
		}
	});

	it('returns undefined when the node has no ssh dir', async () => {
		assert.strictEqual(await materializeGitSSH(), undefined);
	});

	it('returns undefined when the ssh dir holds no keys', async () => {
		fs.mkdirSync(sshDir, { recursive: true });
		fs.writeFileSync(path.join(sshDir, 'known_hosts'), '');
		assert.strictEqual(await materializeGitSSH(), undefined);
	});

	it('decrypts a sealed key to a 0600 file in a 0700 temp dir and repoints IdentityFile at it', async () => {
		secretDecryptor.registerSecretDecryptor(decryptorFor(keypair));
		writeSSHDir({ deploy: seal(KEY_MATERIAL) });

		const materialized = await materializeGitSSH();
		assert.ok(materialized, 'expected a GIT_SSH_COMMAND');

		const configPath = materialized.command.match(/ssh -F (\S+)/)[1];
		const tempDir = path.dirname(configPath);
		assert.ok(path.basename(tempDir).startsWith('harper-ssh-'));

		// the plaintext exists, but only here
		const transientKey = path.join(tempDir, 'deploy.key');
		assert.strictEqual(fs.readFileSync(transientKey, 'utf8'), KEY_MATERIAL);
		assert.strictEqual(fs.statSync(transientKey).mode & 0o777, 0o600, 'key file must be 0600');
		assert.strictEqual(fs.statSync(tempDir).mode & 0o777, 0o700, 'temp dir must be 0700');

		// ssh is pointed at the transient copy, not the sealed durable one
		const config = fs.readFileSync(configPath, 'utf8');
		assert.ok(config.includes(`IdentityFile ${transientKey}`), `config should point at the transient key: ${config}`);
		assert.ok(!config.includes(sshDir), 'no IdentityFile should still point into the durable ssh dir');

		// the durable copy is untouched and still sealed
		assert.ok(fs.readFileSync(path.join(sshDir, 'deploy.key'), 'utf8').startsWith(ENC_PREFIX));

		// known_hosts is not secret and stays where it is
		assert.ok(materialized.command.includes(`UserKnownHostsFile=${path.join(sshDir, 'known_hosts')}`));

		await materialized.cleanup();
		assert.ok(!fs.existsSync(tempDir), 'cleanup must remove the plaintext');
	});

	it('passes a legacy plaintext key through unchanged (pre-#581 keys keep working)', async () => {
		writeSSHDir({ legacy: KEY_MATERIAL });

		const materialized = await materializeGitSSH();
		const tempDir = path.dirname(materialized.command.match(/ssh -F (\S+)/)[1]);

		assert.strictEqual(fs.readFileSync(path.join(tempDir, 'legacy.key'), 'utf8'), KEY_MATERIAL);
		assert.strictEqual(fs.statSync(path.join(tempDir, 'legacy.key')).mode & 0o777, 0o600);

		await materialized.cleanup();
		assert.ok(!fs.existsSync(tempDir));
	});

	it('skips a sealed key when no custody is registered, and never logs the envelope or key', async () => {
		const envelope = seal(KEY_MATERIAL);
		writeSSHDir({ deploy: envelope });

		const materialized = await materializeGitSSH();
		const tempDir = path.dirname(materialized.command.match(/ssh -F (\S+)/)[1]);

		// no plaintext was produced — the key is simply unusable on this node
		assert.ok(!fs.existsSync(path.join(tempDir, 'deploy.key')));

		const complaint = logged.find((line) => line.includes('deploy.key'));
		assert.ok(complaint, `expected a loud log, got: ${JSON.stringify(logged)}`);
		assert.ok(complaint.includes('no secret custody'), complaint);
		for (const line of logged) {
			assert.ok(!line.includes('OPENSSH PRIVATE KEY'), 'a log must never carry key material');
			assert.ok(!line.includes(envelope), 'a log must never carry the envelope');
		}

		await materialized.cleanup();
	});

	it('skips a key sealed under a different cluster key rather than failing the whole spawn', async () => {
		secretDecryptor.registerSecretDecryptor(decryptorFor(keypair));
		writeSSHDir({ ours: seal(KEY_MATERIAL), foreign: seal(KEY_MATERIAL, makeKeypair()) });

		const materialized = await materializeGitSSH();
		const tempDir = path.dirname(materialized.command.match(/ssh -F (\S+)/)[1]);

		// the usable key still materializes; only the undecryptable one drops out
		assert.strictEqual(fs.readFileSync(path.join(tempDir, 'ours.key'), 'utf8'), KEY_MATERIAL);
		assert.ok(!fs.existsSync(path.join(tempDir, 'foreign.key')));
		assert.ok(
			logged.some((line) => line.includes('foreign.key') && line.includes('Failed to decrypt')),
			`expected a decrypt failure for the foreign key, got: ${JSON.stringify(logged)}`
		);
		for (const line of logged) assert.ok(!line.includes('OPENSSH PRIVATE KEY'));

		await materialized.cleanup();
	});

	it('skips a stray subdirectory in the ssh dir instead of throwing EISDIR', async () => {
		writeSSHDir({ deploy: KEY_MATERIAL });
		// A subdirectory that happens to end in `.key` used to reach `readFile` and throw EISDIR,
		// aborting the whole materialize call (and therefore the whole spawn, including an
		// unrelated npm install).
		fs.mkdirSync(path.join(sshDir, 'nested.key'));

		const materialized = await materializeGitSSH();
		assert.ok(materialized, 'a stray subdirectory must not abort materialization');
		const tempDir = path.dirname(materialized.command.match(/ssh -F (\S+)/)[1]);

		assert.strictEqual(fs.readFileSync(path.join(tempDir, 'deploy.key'), 'utf8'), KEY_MATERIAL);
		assert.ok(!fs.existsSync(path.join(tempDir, 'nested.key')), 'the directory entry must not be materialized');

		await materialized.cleanup();
	});

	it('skips a key that cannot be read (permission drift) without aborting the whole materialize call', async function () {
		if (typeof process.getuid === 'function' && process.getuid() === 0) {
			// chmod-based permission denial is a no-op for root; there's no reliable way to force a
			// read failure in that case, so skip rather than false-pass or false-fail.
			this.skip();
			return;
		}

		writeSSHDir({ readable: KEY_MATERIAL, unreadable: KEY_MATERIAL });
		const unreadableKeyPath = path.join(sshDir, 'unreadable.key');
		fs.chmodSync(unreadableKeyPath, 0o000);

		try {
			const materialized = await materializeGitSSH();
			assert.ok(materialized, 'an unreadable key must not abort materialization of the others');
			const tempDir = path.dirname(materialized.command.match(/ssh -F (\S+)/)[1]);

			// the readable key still materializes; only the unreadable one drops out
			assert.strictEqual(fs.readFileSync(path.join(tempDir, 'readable.key'), 'utf8'), KEY_MATERIAL);
			assert.ok(!fs.existsSync(path.join(tempDir, 'unreadable.key')));
			assert.ok(
				logged.some((line) => line.includes('unreadable.key') && line.includes('Failed to read')),
				`expected a read failure log for the unreadable key, got: ${JSON.stringify(logged)}`
			);
			for (const line of logged)
				assert.ok(!line.includes('OPENSSH PRIVATE KEY'), 'a log must never carry key material');

			await materialized.cleanup();
		} finally {
			fs.chmodSync(unreadableKeyPath, 0o600); // restore so afterEach's rmSync can clean up
		}
	});

	it('skips a tampered envelope (GCM auth tag failure)', async () => {
		secretDecryptor.registerSecretDecryptor(decryptorFor(keypair));
		const envelope = seal(KEY_MATERIAL);
		// flip a byte in the base64url body — the auth tag no longer verifies
		const tampered =
			ENC_PREFIX + (envelope.slice(-1) === 'A' ? envelope.slice(7, -1) + 'B' : envelope.slice(7, -1) + 'A');
		writeSSHDir({ deploy: tampered });

		const materialized = await materializeGitSSH();
		const tempDir = path.dirname(materialized.command.match(/ssh -F (\S+)/)[1]);

		assert.ok(!fs.existsSync(path.join(tempDir, 'deploy.key')));
		assert.ok(logged.some((line) => line.includes('deploy.key')));

		await materialized.cleanup();
	});
});

describe('rewriteSshConfigPaths (cross-platform IdentityFile rewrite)', () => {
	// materializeGitSSH always calls this with process.platform, but the platform param lets us
	// pin Windows-shaped behavior (mixed slash direction, drive-letter case-insensitivity) from
	// any CI host — this is exactly the kind of platform-specific logic that's easy to "fix"
	// without ever actually exercising the Windows branch.

	it('rewrites an exact-match posix path (existing behavior preserved)', () => {
		const config = 'Host gh\n\tIdentityFile /data/hdb/ssh/deploy.key\n\tIdentitiesOnly yes';
		const rewritten = rewriteSshConfigPaths(config, '/data/hdb/ssh', '/tmp/harper-ssh-abc', 'darwin');
		assert.strictEqual(rewritten, 'Host gh\n\tIdentityFile /tmp/harper-ssh-abc/deploy.key\n\tIdentitiesOnly yes');
	});

	it('rewrites when the config uses forward slashes but sshDir (path.join on win32) uses backslashes', () => {
		const sshDir = 'C:\\Users\\svc\\hdb\\ssh';
		const tempDir = 'C:\\Users\\svc\\AppData\\Local\\Temp\\harper-ssh-xyz';
		const config = 'Host gh\n\tIdentityFile C:/Users/svc/hdb/ssh/deploy.key\n';
		const rewritten = rewriteSshConfigPaths(config, sshDir, tempDir, 'win32');
		assert.strictEqual(
			rewritten,
			'Host gh\n\tIdentityFile C:/Users/svc/AppData/Local/Temp/harper-ssh-xyz/deploy.key\n'
		);
	});

	it('is case-insensitive on win32 for drive-letter casing', () => {
		const sshDir = 'C:\\Users\\svc\\hdb\\ssh';
		const tempDir = 'C:\\Users\\svc\\AppData\\Local\\Temp\\harper-ssh-xyz';
		const config = 'Host gh\n\tIdentityFile c:\\Users\\svc\\hdb\\ssh\\deploy.key\n';
		const rewritten = rewriteSshConfigPaths(config, sshDir, tempDir, 'win32');
		assert.ok(
			rewritten.includes('C:/Users/svc/AppData/Local/Temp/harper-ssh-xyz'),
			`expected the lowercase drive-letter path to still be rewritten, got: ${rewritten}`
		);
		assert.ok(!rewritten.includes('hdb'), 'the durable ssh dir must not remain in the rewritten config');
	});

	it('does not case-fold on non-Windows platforms', () => {
		// A differently-cased sshDir must NOT match on posix — case sensitivity there is real.
		const config = 'IdentityFile /Data/HDB/ssh/deploy.key\n';
		const rewritten = rewriteSshConfigPaths(config, '/data/hdb/ssh', '/tmp/harper-ssh-abc', 'linux');
		assert.strictEqual(rewritten, config, 'a differently-cased path must be left untouched on posix');
	});

	it('does not partial-match a sibling directory whose name starts with sshDir', () => {
		const config = 'IdentityFile /data/hdb/sshhh/other.key\n';
		const rewritten = rewriteSshConfigPaths(config, '/data/hdb/ssh', '/tmp/harper-ssh-abc', 'darwin');
		assert.strictEqual(rewritten, config, 'a sibling directory like .../sshhh must not be touched');
	});

	it('escapes regex-special characters within a path segment (e.g. parens) without breaking separator matching', () => {
		const sshDir = '/data/hdb (prod)/ssh';
		const config = 'IdentityFile /data/hdb (prod)/ssh/deploy.key\n';
		const rewritten = rewriteSshConfigPaths(config, sshDir, '/tmp/harper-ssh-abc', 'linux');
		assert.strictEqual(rewritten, 'IdentityFile /tmp/harper-ssh-abc/deploy.key\n');
	});

	it('rewrites every IdentityFile occurrence (global match)', () => {
		const config = 'IdentityFile /data/hdb/ssh/a.key\nIdentityFile /data/hdb/ssh/b.key\n';
		const rewritten = rewriteSshConfigPaths(config, '/data/hdb/ssh', '/tmp/harper-ssh-abc', 'darwin');
		assert.strictEqual(rewritten, 'IdentityFile /tmp/harper-ssh-abc/a.key\nIdentityFile /tmp/harper-ssh-abc/b.key\n');
	});
});

describe('nonInteractiveSpawn transient ssh lifetime', () => {
	let rootDir;
	let sshDir;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ssh-spawn-test-'));
		sshDir = path.join(rootDir, 'ssh');
		env.setProperty(terms.CONFIG_PARAMS.ROOTPATH, rootDir);
		fs.mkdirSync(sshDir, { recursive: true });
		fs.writeFileSync(path.join(sshDir, 'deploy.key'), KEY_MATERIAL, { mode: 0o600 });
		fs.writeFileSync(
			path.join(sshDir, 'config'),
			`#deploy\nHost gh\n\tIdentityFile ${path.join(sshDir, 'deploy.key')}\n\tIdentitiesOnly yes`
		);
		fs.writeFileSync(path.join(sshDir, 'known_hosts'), '');
	});

	afterEach(() => {
		fs.rmSync(rootDir, { recursive: true, force: true });
		for (const leftover of tempSSHDirs()) {
			fs.rmSync(path.join(os.tmpdir(), leftover), { recursive: true, force: true });
		}
	});

	it('exposes GIT_SSH_COMMAND to the child and removes the key material once it exits', async () => {
		const { stdout, code } = await nonInteractiveSpawn('app', 'printenv', ['GIT_SSH_COMMAND'], rootDir);

		assert.strictEqual(code, 0);
		assert.match(stdout, /^ssh -F \S*harper-ssh-\S+[/\\]config /, `unexpected GIT_SSH_COMMAND: ${stdout}`);
		assert.deepStrictEqual(tempSSHDirs(), [], 'the transient ssh dir must not outlive the spawn');
	});

	it('removes the key material when the command FAILS (cleanup-on-error)', async () => {
		const { code } = await nonInteractiveSpawn('app', 'sh', ['-c', '"exit 3"'], rootDir);

		assert.strictEqual(code, 3);
		assert.deepStrictEqual(tempSSHDirs(), [], 'a failed git operation must still clean up the plaintext key');
	});

	it('removes the key material when the command times out', async () => {
		await assert.rejects(nonInteractiveSpawn('app', 'sleep', ['30'], rootDir, 200), /timed out/);

		assert.deepStrictEqual(tempSSHDirs(), [], 'a timed-out git operation must still clean up the plaintext key');
	});
});
