/**
 * Promoted from qa-explorer (QA-581 / P-485): regression anchor for harper#1795 ("Decrypt SSH deploy
 * keys to a transient file for git operations").
 *
 * Invariant: a deploy key in `<rootPath>/ssh/*.key` reaches ssh only as a transient plaintext copy —
 * a 0600 file in a fresh 0700 `harper-ssh-*` dir under the OS tmpdir, never under the served root —
 * and that dir is gone once the git spawn settles, on success and on failure alike. An `enc:v1:` key
 * is decrypted into the copy while the durable file stays sealed, and neither the key nor the
 * envelope reaches the server log. Pre-#1795, `GIT_SSH_COMMAND` pointed ssh at the durable key
 * itself, so no transient dir existed and a sealed key never authenticated.
 *
 * This drives the real path end to end: `deploy_component` clones a `git+ssh://` URL from a local
 * bare repo through an unprivileged sshd on a free 127.0.0.1 port (throwaway host key, key auth
 * only). The deploy key's `authorized_keys` entry forces `sleep 2` before running git, which holds
 * the transient key on disk long enough for a 10 ms poller to capture its modes and content; sshd's
 * `Accepted publickey` line proves the copy is what authenticated.
 *
 * Core ships no decryptor and no `add_ssh_key` (both Harper Pro), so the spec writes `<rootPath>/ssh`
 * directly and registers a base64 fake decryptor as a builtin component (see
 * qa581-ssh-deploy-key/registerFakeDecryptor.js).
 *
 * unitTests/components/gitSSHMaterialization.test.js pins `materializeGitSSH` in isolation; this
 * file pins its wiring into a real deploy over real ssh transport.
 *
 * Needs /usr/sbin/sshd, ssh-keygen and git. Without sshd the suite skips, unless
 * HARPER_TEST_REQUIRE_SSHD is set (as CI sets it), in which case it fails.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/qa581-ssh-deploy-key.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_ROOT = join(import.meta.dirname, 'qa581-ssh-deploy-key');
const ENC_PREFIX = 'enc:v1:';
const SSHD_BIN = '/usr/sbin/sshd';
const sshdMissingReason =
	process.platform === 'win32' ? 'no sshd on Windows' : existsSync(SSHD_BIN) ? undefined : `${SSHD_BIN} not found`;

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : undefined;
			server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
		});
		server.on('error', reject);
	});
}

function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = createConnection({ host, port }, () => {
				socket.end();
				resolve();
			});
			socket.on('error', () => {
				socket.destroy();
				if (Date.now() > deadline) reject(new Error(`sshd never opened ${host}:${port}`));
				else setTimeout(attempt, 50);
			});
		};
		attempt();
	});
}

/** `materializeGitSSH`'s transient dirs (its `mkdtemp` prefix) currently in the OS tmpdir. */
async function scanTransientSshDirs(): Promise<string[]> {
	const entries = await readdir(tmpdir()).catch(() => [] as string[]);
	return entries.filter((name) => name.startsWith('harper-ssh-'));
}

interface ObservedMaterialization {
	tempDir: string;
	keyFiles: { name: string; content: string; mode: number }[];
	dirMode: number;
}

/**
 * Poll for a transient ssh dir while `inFlight` is pending and snapshot the first one that still
 * holds a key file. Returns null if none was seen.
 */
async function observeDuringFlight(inFlight: Promise<unknown>): Promise<ObservedMaterialization | null> {
	let observed: ObservedMaterialization | null = null;
	let polling = true;
	inFlight.finally(() => {
		polling = false;
	});
	while (polling) {
		const dirs = await scanTransientSshDirs();
		if (dirs.length > 0 && !observed) {
			try {
				const tempDir = join(tmpdir(), dirs[0]);
				const dirStat = await stat(tempDir);
				const names = (await readdir(tempDir)).filter((n) => n.endsWith('.key'));
				const keyFiles = [];
				for (const name of names) {
					const filePath = join(tempDir, name);
					const [content, fileStat] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
					keyFiles.push({ name, content, mode: fileStat.mode & 0o777 });
				}
				if (keyFiles.length > 0) observed = { tempDir, keyFiles, dirMode: dirStat.mode & 0o777 };
			} catch {
				// cleanup removed it between readdir and stat; keep polling for a snapshot with content
			}
		}
		await sleep(10);
	}
	return observed;
}

/** A 40-char slice of the key body: distinctive enough that a log hit means key bytes leaked. */
function keyMarker(pemContent: string): string {
	const body = pemContent
		.split('\n')
		.filter((line) => line && !line.startsWith('-----'))
		.join('');
	ok(body.length > 60, 'key body too short to slice a marker from');
	return body.slice(20, 60);
}

suite(
	'SSH deploy keys are materialized transiently for git (#1795)',
	{ skip: !process.env.HARPER_TEST_REQUIRE_SSHD && sshdMissingReason },
	(ctx: ContextWithHarper) => {
		let sshWorkDir: string;
		let sshdProcess: ChildProcess;
		const sshdLog: string[] = [];
		let sshdPort: number;
		let bareRepoPath: string;
		let hostKnownHostsLine: string;
		let deployPrivateKeyContent: string;
		let deployMarker: string;
		let client: ReturnType<typeof createApiClient>;
		const currentUser = userInfo().username;

		before(async () => {
			if (sshdMissingReason) {
				throw new Error(`HARPER_TEST_REQUIRE_SSHD is set but ${sshdMissingReason}; this suite cannot run`);
			}
			sshWorkDir = await mkdtemp(join(tmpdir(), 'qa581-sshenv-'));

			execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', join(sshWorkDir, 'hostkey'), '-N', '', '-q']);
			execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', join(sshWorkDir, 'deploykey'), '-N', '', '-q']);
			deployPrivateKeyContent = await readFile(join(sshWorkDir, 'deploykey'), 'utf8');
			deployMarker = keyMarker(deployPrivateKeyContent);

			bareRepoPath = join(sshWorkDir, 'repo.git');
			const workTree = join(sshWorkDir, 'work');
			execFileSync('git', ['init', '--quiet', '--bare', bareRepoPath]);
			execFileSync('git', ['init', '--quiet', '-b', 'main', workTree]);
			execFileSync('git', ['-C', workTree, 'config', 'user.email', 'qa581@example.com']);
			execFileSync('git', ['-C', workTree, 'config', 'user.name', 'QA581']);
			await cp(join(FIXTURE_ROOT, 'app'), workTree, { recursive: true });
			execFileSync('git', ['-C', workTree, 'add', '-A']);
			execFileSync('git', ['-C', workTree, 'commit', '--quiet', '-m', 'qa581 initial']);
			execFileSync('git', ['-C', workTree, 'push', '--quiet', bareRepoPath, 'main']);

			const deployPub = (await readFile(join(sshWorkDir, 'deploykey.pub'), 'utf8')).trim();
			// git sends its command already shell-quoted (`git-upload-pack '/path'`); `eval` strips that
			// quoting instead of passing the quote characters through as part of the path.
			await writeFile(
				join(sshWorkDir, 'authorized_keys'),
				`command="sleep 2 && eval \\"$SSH_ORIGINAL_COMMAND\\"",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding ${deployPub}\n`,
				{ mode: 0o600 }
			);

			sshdPort = await findFreePort();
			const sshdConfig = [
				`Port ${sshdPort}`,
				`ListenAddress 127.0.0.1`,
				`HostKey ${join(sshWorkDir, 'hostkey')}`,
				`AuthorizedKeysFile ${join(sshWorkDir, 'authorized_keys')}`,
				`PubkeyAuthentication yes`,
				`PasswordAuthentication no`,
				`KbdInteractiveAuthentication no`,
				`UsePAM no`,
				`StrictModes no`,
				`PidFile ${join(sshWorkDir, 'sshd.pid')}`,
				`LogLevel VERBOSE`,
				`AllowUsers ${currentUser}`,
			].join('\n');
			await writeFile(join(sshWorkDir, 'sshd_config'), sshdConfig);

			sshdProcess = spawn(SSHD_BIN, ['-f', join(sshWorkDir, 'sshd_config'), '-D', '-e'], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			sshdProcess.stdout?.on('data', (chunk) => sshdLog.push(chunk.toString()));
			sshdProcess.stderr?.on('data', (chunk) => sshdLog.push(chunk.toString()));
			await waitForTcp('127.0.0.1', sshdPort, 5_000);

			const [hostKeyType, hostKey] = (await readFile(join(sshWorkDir, 'hostkey.pub'), 'utf8')).trim().split(' ');
			hostKnownHostsLine = `[127.0.0.1]:${sshdPort} ${hostKeyType} ${hostKey}`;

			await setupHarperWithFixture(ctx, join(FIXTURE_ROOT, 'decryptor-trigger'), {
				env: {
					HARPER_BUILTIN_COMPONENTS:
						'qa581FakeDecryptor=@/integrationTests/security/qa581-ssh-deploy-key/registerFakeDecryptor.js',
				},
			});
			client = createApiClient(ctx.harper);

			// Every sealed-key assertion below depends on the decryptor being registered in Harper's
			// main thread, not merely on the fixture existing.
			const bootLog = await client.req().send({ operation: 'read_log', limit: 5000, order: 'asc' });
			const bootMessages = (bootLog.body as any[]).map((entry) => entry.message ?? '').join('\n');
			ok(
				bootMessages.includes('QA581 fake ssh-key decryptor registered'),
				'precondition failed: fake decryptor never registered'
			);
		});

		after(async () => {
			sshdProcess?.kill('SIGTERM');
			await teardownHarper(ctx);
			if (sshWorkDir) await rm(sshWorkDir, { recursive: true, force: true });
		});

		/** `materializeGitSSH` decrypts every `*.key` on each spawn, so each test rewrites the dir. */
		async function writeDurableSshDir(keyFileName: string, keyFileContent: string) {
			const sshDir = join(ctx.harper.dataRootDir, 'ssh');
			await rm(sshDir, { recursive: true, force: true });
			await mkdir(sshDir, { recursive: true });
			const keyPath = join(sshDir, keyFileName);
			await writeFile(keyPath, keyFileContent, { mode: 0o600 });
			await writeFile(join(sshDir, 'config'), `Host 127.0.0.1\n\tIdentityFile ${keyPath}\n\tIdentitiesOnly yes\n`, {
				mode: 0o600,
			});
			await writeFile(join(sshDir, 'known_hosts'), hostKnownHostsLine + '\n', { mode: 0o600 });
		}

		function deploy(project: string, repoPath: string) {
			return fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation: 'deploy_component',
					project,
					package: `git+ssh://${currentUser}@127.0.0.1:${sshdPort}${repoPath}#main`,
				}),
			});
		}

		test('control: the leftover-dir scan detects a planted harper-ssh-* dir', async () => {
			strictEqual((await scanTransientSshDirs()).length, 0, 'tmpdir must start clean of harper-ssh-* dirs');
			const plantedDir = await mkdtemp(join(tmpdir(), 'harper-ssh-controlprobe-'));
			await writeFile(join(plantedDir, 'planted.key'), 'control probe', { mode: 0o600 });
			try {
				strictEqual((await scanTransientSshDirs()).length, 1, 'scan failed to detect a planted harper-ssh-* dir');
			} finally {
				await rm(plantedDir, { recursive: true, force: true });
			}
			strictEqual((await scanTransientSshDirs()).length, 0);
		});

		test('plaintext key: deploy over ssh succeeds from a 0600 copy in a 0700 tmpdir, removed afterwards', async () => {
			strictEqual((await scanTransientSshDirs()).length, 0, 'leftover transient dirs before this test');
			await writeDurableSshDir('legacy.key', deployPrivateKeyContent);

			const project = 'qa581-legacy';
			const inFlight = deploy(project, bareRepoPath);
			const observed = await observeDuringFlight(inFlight);
			const response = await inFlight;
			const body = await response.json();

			ok(observed, 'no transient ssh dir appeared during the deploy');
			strictEqual(observed.dirMode, 0o700, `transient dir mode ${observed.dirMode.toString(8)}`);
			const materializedKey = observed.keyFiles.find((key) => key.name === 'legacy.key');
			ok(materializedKey, `legacy.key not materialized: ${JSON.stringify(observed.keyFiles.map((k) => k.name))}`);
			strictEqual(materializedKey.mode, 0o600, `materialized key mode ${materializedKey.mode.toString(8)}`);
			strictEqual(materializedKey.content, deployPrivateKeyContent, 'a plaintext key must be copied byte for byte');
			ok(observed.tempDir.startsWith(tmpdir()), `transient dir ${observed.tempDir} is not under the OS tmpdir`);
			ok(!observed.tempDir.startsWith(ctx.harper.dataRootDir), 'transient dir must not be under the root path');

			strictEqual(response.status, 200, `deploy failed: ${JSON.stringify(body)}`);
			strictEqual(body.message, `Successfully deployed: ${project}`);
			ok(existsSync(join(ctx.harper.dataRootDir, 'components', project)), 'component directory missing after deploy');
			ok(sshdLog.join('').includes('Accepted publickey'), 'sshd never accepted the deploy key');

			const remaining = await scanTransientSshDirs();
			strictEqual(remaining.length, 0, `transient ssh dir leaked after a successful deploy: ${remaining}`);
		});

		test('sealed key: deploy authenticates with the decrypted copy; the durable key stays sealed', async () => {
			strictEqual((await scanTransientSshDirs()).length, 0, 'leftover transient dirs before this test');
			const sealed = ENC_PREFIX + Buffer.from(deployPrivateKeyContent, 'utf8').toString('base64');
			await writeDurableSshDir('sealed.key', sealed);

			const project = 'qa581-sealed';
			const inFlight = deploy(project, bareRepoPath);
			const observed = await observeDuringFlight(inFlight);
			const response = await inFlight;
			const body = await response.json();

			ok(observed, 'no transient ssh dir appeared during the deploy');
			const materializedKey = observed.keyFiles.find((key) => key.name === 'sealed.key');
			ok(materializedKey, `sealed.key not materialized: ${JSON.stringify(observed.keyFiles.map((k) => k.name))}`);
			strictEqual(materializedKey.mode, 0o600, `materialized key mode ${materializedKey.mode.toString(8)}`);
			strictEqual(materializedKey.content, deployPrivateKeyContent, 'the transient copy must be the decrypted key');
			strictEqual(
				await readFile(join(ctx.harper.dataRootDir, 'ssh', 'sealed.key'), 'utf8'),
				sealed,
				'the durable key must stay sealed'
			);

			strictEqual(response.status, 200, `deploy failed: ${JSON.stringify(body)}`);
			strictEqual(body.message, `Successfully deployed: ${project}`);
			ok(existsSync(join(ctx.harper.dataRootDir, 'components', project)), 'component directory missing after deploy');

			const remaining = await scanTransientSshDirs();
			strictEqual(remaining.length, 0, `transient ssh dir leaked after a successful deploy: ${remaining}`);
		});

		test('failed clone (auth succeeds, repo missing) still removes the transient key', async () => {
			strictEqual((await scanTransientSshDirs()).length, 0, 'leftover transient dirs before this test');
			const sealed = ENC_PREFIX + Buffer.from(deployPrivateKeyContent, 'utf8').toString('base64');
			await writeDurableSshDir('sealed.key', sealed);

			const inFlight = deploy('qa581-error-path', join(sshWorkDir, 'does-not-exist.git'));
			const observed = await observeDuringFlight(inFlight);
			const response = await inFlight;
			const body = await response.json();

			ok(observed, 'no transient ssh dir appeared before the clone failed');
			strictEqual(
				observed.keyFiles.find((key) => key.name === 'sealed.key')?.content,
				deployPrivateKeyContent,
				'the key must have been decrypted while it existed'
			);
			notStrictEqual(response.status, 200, `expected the deploy to fail, got 200: ${JSON.stringify(body)}`);

			const remaining = await scanTransientSshDirs();
			strictEqual(remaining.length, 0, `transient ssh dir leaked after a failed deploy: ${remaining}`);
		});

		test('neither the key nor its enc:v1: envelope reaches the server log', async () => {
			const logResponse = await client.req().send({ operation: 'read_log', limit: 20000, order: 'desc' });
			strictEqual(logResponse.status, 200, `read_log failed: ${JSON.stringify(logResponse.body)}`);
			const allMessages = (logResponse.body as any[]).map((entry) => entry.message ?? '').join('\n');

			ok(allMessages.includes('qa581-legacy'), 'the log scan must see the deploys above for its zero hits to count');
			const sealedEnvelope = ENC_PREFIX + Buffer.from(deployPrivateKeyContent, 'utf8').toString('base64');
			ok(!allMessages.includes(deployMarker), `key body leaked into the server log: ${deployMarker}`);
			ok(!allMessages.includes('BEGIN OPENSSH PRIVATE KEY'), 'a private key header leaked into the server log');
			ok(!allMessages.includes(sealedEnvelope), 'the enc:v1: envelope leaked into the server log');
		});
	}
);
