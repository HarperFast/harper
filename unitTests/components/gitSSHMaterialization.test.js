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
const { materializeGitSSH, nonInteractiveSpawn } = require('#src/components/Application');
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
