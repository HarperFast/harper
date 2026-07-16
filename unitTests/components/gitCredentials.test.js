'use strict';

// Covers the git-host credential channel used by private git-reference deploys (#1792): a per-deploy
// socket serves the token from memory, gitCredentialHelper.js relays git's request over it, and the
// environment that reaches the helper is granted to the clone spawn only.
//
// The helper is exercised as a real child process (the way git runs it), not stubbed — the point of
// the design is what crosses the process boundary, so a mocked helper would test nothing.

const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const {
	startGitCredentialSession,
	normalizeGitHost,
	DEFAULT_GIT_USERNAME,
	GIT_CREDENTIAL_SOCKET_ENV,
} = require('#src/components/gitCredentialServer');
const { Application, GIT_CREDENTIAL_HELPER_PATH, nonInteractiveSpawn } = require('#src/components/Application');

// Run the helper exactly as git would: the credential-helper protocol (operation as the last
// argument, key=value request on stdin) or the GIT_ASKPASS protocol (prompt as the first argument).
function runHelper({ args, stdin, env }) {
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[GIT_CREDENTIAL_HELPER_PATH, ...args],
			{ env: { ...process.env, ...env } },
			(error, stdout, stderr) => {
				// A non-zero exit is a valid outcome here (git treats it as "no credential"), so report it
				// rather than rejecting.
				if (error && typeof error.code !== 'number') return reject(error);
				resolve({ stdout, stderr, code: error ? error.code : 0 });
			}
		);
		child.stdin.end(stdin ?? '');
	});
}

describe('normalizeGitHost', () => {
	it('reduces the forms a credential entry or a git prompt can carry to one host key', () => {
		for (const input of ['github.com', 'GitHub.com', 'https://github.com', 'https://github.com/', '//github.com']) {
			assert.strictEqual(normalizeGitHost(input), 'github.com', input);
		}
		// userinfo in a prompt URL is not part of the host identity
		assert.strictEqual(normalizeGitHost('https://x-access-token@github.com'), 'github.com');
		// a non-default port is, since it identifies a different endpoint
		assert.strictEqual(normalizeGitHost('git.example.com:8443'), 'git.example.com:8443');
	});
});

describe('git credential session', () => {
	let session;

	afterEach(async () => {
		await session?.close();
		session = undefined;
	});

	it('serves the token over the socket to a helper run as a git credential helper', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);

		const { stdout } = await runHelper({
			args: ['get'],
			stdin: 'protocol=https\nhost=github.com\n\n',
			env: session.env,
		});

		assert.strictEqual(stdout, `username=${DEFAULT_GIT_USERNAME}\npassword=ghp_secret\n`);
	});

	it('answers a GIT_ASKPASS username prompt and password prompt, locale independently', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);

		// The username prompt's URL has no userinfo; the password prompt's does. That structural
		// difference is what the helper keys on, so a translated prompt still resolves correctly.
		const username = await runHelper({ args: [`Username for 'https://github.com': `], env: session.env });
		assert.strictEqual(username.stdout, `${DEFAULT_GIT_USERNAME}\n`);

		const password = await runHelper({
			args: [`Password for 'https://x-access-token@github.com': `],
			env: session.env,
		});
		assert.strictEqual(password.stdout, 'ghp_secret\n');

		const translated = await runHelper({
			args: [`Mot de passe pour 'https://x-access-token@github.com' : `],
			env: session.env,
		});
		assert.strictEqual(translated.stdout, 'ghp_secret\n', 'a localized prompt still yields the password');
	});

	it('last-write-wins on a duplicate host, and the session still serves the surviving token', async () => {
		session = await startGitCredentialSession(
			[
				{ host: 'github.com', token: 'first' },
				{ host: 'github.com', token: 'second' },
			],
			GIT_CREDENTIAL_HELPER_PATH
		);
		const { stdout } = await runHelper({
			args: ['get'],
			stdin: 'protocol=https\nhost=github.com\n\n',
			env: session.env,
		});
		assert.strictEqual(stdout, `username=${DEFAULT_GIT_USERNAME}\npassword=second\n`);
	});

	it('honors a per-entry username (GitLab/Bitbucket use their own convention)', async () => {
		session = await startGitCredentialSession(
			[{ host: 'gitlab.com', token: 'glpat', username: 'oauth2' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		const { stdout } = await runHelper({
			args: ['get'],
			stdin: 'protocol=https\nhost=gitlab.com\n\n',
			env: session.env,
		});
		assert.strictEqual(stdout, 'username=oauth2\npassword=glpat\n');
	});

	it('answers nothing for a host it holds no credential for', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		// Silence rather than an error: git also asks about public hosts, and the clone of a public
		// dependency must proceed unauthenticated instead of failing the deploy.
		const { stdout } = await runHelper({
			args: ['get'],
			stdin: 'protocol=https\nhost=evil.example.com\n\n',
			env: session.env,
		});
		assert.strictEqual(stdout, '');
	});

	it('refuses to serve a credential over cleartext http (only https, plus loopback)', async () => {
		session = await startGitCredentialSession(
			[
				{ host: 'github.com', token: 'ghp_secret' },
				{ host: '127.0.0.1:8080', token: 'local_tok' },
			],
			GIT_CREDENTIAL_HELPER_PATH
		);
		// A public host over http would put the token on the wire in the clear — refuse.
		const cleartext = await runHelper({
			args: ['get'],
			stdin: 'protocol=http\nhost=github.com\n\n',
			env: session.env,
		});
		assert.strictEqual(cleartext.stdout, '', 'no credential over http to a public host');
		// A loopback remote never touches a network, so http to it is fine (integration tests use it).
		const loopback = await runHelper({
			args: ['get'],
			stdin: 'protocol=http\nhost=127.0.0.1:8080\n\n',
			env: session.env,
		});
		assert.strictEqual(loopback.stdout, 'username=x-access-token\npassword=local_tok\n');
	});

	it('refuses to serve a token carrying a newline (would truncate or inject protocol attributes)', async () => {
		// A literal token is rejected by the op schema, but one resolved from an hdb_secret row is not,
		// so the write boundary must guard it — parity with the .npmrc writer.
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp\nquit=1' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		const { stdout } = await runHelper({
			args: ['get'],
			stdin: 'protocol=https\nhost=github.com\n\n',
			env: session.env,
		});
		assert.strictEqual(stdout, '');
	});

	it('never yields the token to a store/erase request (the credential is not persistable)', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		for (const operation of ['store', 'erase']) {
			const { stdout } = await runHelper({
				args: [operation],
				stdin: 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_secret\n\n',
				env: session.env,
			});
			assert.strictEqual(stdout, '', `${operation} yields nothing`);
		}
	});

	it('resets any inherited credential.helper so a configured `store` cannot persist the token', async () => {
		session = await startGitCredentialSession([{ host: 'github.com', token: 't' }], GIT_CREDENTIAL_HELPER_PATH);
		const count = Number(session.env.GIT_CONFIG_COUNT);
		// The first of our two entries clears git's helper list; the second installs ours. Without the
		// reset, git would report the successful authentication to an inherited helper — a machine with
		// `credential.helper=store` would write this token to ~/.git-credentials.
		assert.strictEqual(session.env[`GIT_CONFIG_KEY_${count - 2}`], 'credential.helper');
		assert.strictEqual(session.env[`GIT_CONFIG_VALUE_${count - 2}`], '');
		assert.strictEqual(session.env[`GIT_CONFIG_KEY_${count - 1}`], 'credential.helper');
		assert.ok(session.env[`GIT_CONFIG_VALUE_${count - 1}`].startsWith('!'), 'ours is a shell-invoked helper');
		assert.strictEqual(session.env.GIT_TERMINAL_PROMPT, '0', 'git must fail rather than hang on a prompt');
	});

	it('keeps the token off disk: the socket dir is 0700 and holds only a socket', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		const socketPath = session.env[GIT_CREDENTIAL_SOCKET_ENV];
		const socketDir = path.dirname(socketPath);

		assert.strictEqual((await fs.stat(socketDir)).mode & 0o777, 0o700, 'socket dir is owner-only');
		const entries = await fs.readdir(socketDir);
		assert.deepStrictEqual(entries, ['credential.sock']);
		assert.ok((await fs.stat(socketPath)).isSocket(), 'the only artifact is a socket, not a file with a token');
	});

	it('stops answering once the session is closed', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		const env = session.env;
		const socketPath = env[GIT_CREDENTIAL_SOCKET_ENV];

		await session.close();
		session = undefined;

		// The credential is gone the moment the clone finishes — anything that runs later in the deploy
		// (install scripts included) finds nothing to ask.
		const { stdout, code } = await runHelper({ args: ['get'], stdin: 'protocol=https\nhost=github.com\n\n', env });
		assert.strictEqual(stdout, '');
		assert.strictEqual(code, 1, 'helper reports failure rather than silently succeeding');
		await assert.rejects(fs.stat(socketPath), /ENOENT/, 'socket removed');
	});

	it('refuses to start on a git too old for the credential-helper reset', async () => {
		// git < 2.31 ignores GIT_CONFIG_*, so the reset that stops an inherited `store` helper from
		// persisting the token would be silently dead — fail the deploy rather than leak.
		const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-fake-git-'));
		const fakeGit = path.join(fakeBin, 'git');
		await fs.writeFile(fakeGit, '#!/bin/sh\necho "git version 2.30.2"\n', { mode: 0o755 });
		const priorPath = process.env.PATH;
		process.env.PATH = `${fakeBin}:${priorPath}`;
		try {
			await assert.rejects(
				() => startGitCredentialSession([{ host: 'github.com', token: 't' }], GIT_CREDENTIAL_HELPER_PATH),
				/2\.31 or newer is required/
			);
		} finally {
			process.env.PATH = priorPath;
			await fs.rm(fakeBin, { recursive: true, force: true });
		}
	});

	it('drops a connection that streams without end, rather than buffering it into an OOM', async () => {
		session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		const socket = net.connect(session.env[GIT_CREDENTIAL_SOCKET_ENV]);
		await new Promise((resolve, reject) => {
			socket.on('connect', resolve);
			socket.on('error', reject);
		});

		const closed = new Promise((resolve) => socket.on('close', resolve));
		// Never half-close: without a cap the server would accumulate this forever.
		const junk = 'x'.repeat(64 * 1024);
		// write() can return false under backpressure (the socket's internal buffer is full) well
		// before the server-side cap is exceeded; resume on 'drain' instead of giving up, or this
		// test hangs waiting for a 'close' the server never has a reason to send.
		const write = () => {
			if (!socket.writable) return;
			if (socket.write(junk)) setImmediate(write);
			else socket.once('drain', write);
		};
		write();

		await closed; // the server destroys the connection instead of growing its buffer
		assert.ok(socket.destroyed);
	});

	it('is inert without a session: the helper carries no secret of its own', async () => {
		// GIT_CREDENTIAL_SOCKET_ENV is the only variable that carries authority. A helper reached with
		// it stripped answers nothing, which is what makes stripping it from the install spawn sufficient.
		const { stdout, code } = await runHelper({
			args: ['get'],
			stdin: 'protocol=https\nhost=github.com\n\n',
			env: { [GIT_CREDENTIAL_SOCKET_ENV]: undefined },
		});
		assert.strictEqual(stdout, '');
		assert.strictEqual(code, 0);
	});
});

describe('Application git credential lifecycle', () => {
	it('partitions resolved credentials by kind and exposes git env only while the session is open', async () => {
		const app = new Application({
			name: 'git-credentials-test',
			packageIdentifier: 'github:myorg/private-app',
			credentials: [
				{ registry: 'https://npm.pkg.github.com', token: 'npm-tok', scope: '@myorg' },
				{ host: 'github.com', token: 'git-tok' },
			],
		});

		assert.deepStrictEqual(app.registryCredentials, [
			{ registry: 'https://npm.pkg.github.com', token: 'npm-tok', scope: '@myorg' },
		]);
		assert.deepStrictEqual(app.gitCredentials, [{ host: 'github.com', token: 'git-tok' }]);
		assert.strictEqual(app.gitCredentialEnv, undefined, 'no env before the session starts');

		await app.startGitCredentialSession();
		assert.ok(app.gitCredentialEnv[GIT_CREDENTIAL_SOCKET_ENV], 'env carries the socket while open');

		await app.cleanupGitCredentialSession();
		assert.strictEqual(app.gitCredentialEnv, undefined, 'env cleared after cleanup');
		assert.strictEqual(app.gitCredentials, undefined, 'in-memory tokens dropped after cleanup');
	});

	it('starting a session is a no-op without git credentials', async () => {
		const app = new Application({
			name: 'no-git-credentials-test',
			packageIdentifier: 'npm:@myorg/app',
			credentials: [{ registry: 'https://npm.pkg.github.com', token: 'npm-tok' }],
		});
		await app.startGitCredentialSession();
		assert.strictEqual(app.gitCredentialEnv, undefined);
		await app.cleanupGitCredentialSession();
	});
});

describe('nonInteractiveSpawn git credential scoping', () => {
	let scriptDir;
	let scriptPath;

	before(async () => {
		scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harper-env-probe-'));
		scriptPath = path.join(scriptDir, 'probe.js');
		// Stands in for a dependency's install script: prints whatever git credential wiring it inherited.
		await fs.writeFile(
			scriptPath,
			`const keys = Object.keys(process.env).filter((k) => k.startsWith('GIT_') || k === '${GIT_CREDENTIAL_SOCKET_ENV}');\n` +
				`process.stdout.write(JSON.stringify(keys.sort()));\n`
		);
	});

	after(async () => {
		await fs.rm(scriptDir, { recursive: true, force: true });
	});

	async function probeEnv(gitCredentialEnv) {
		const { stdout, code } = await nonInteractiveSpawn(
			'env-probe',
			process.execPath,
			[scriptPath],
			scriptDir,
			30_000,
			undefined,
			undefined,
			gitCredentialEnv
		);
		assert.strictEqual(code, 0, `probe exited ${code}`);
		return JSON.parse(stdout.slice(stdout.indexOf('[')));
	}

	it('grants the credential environment to the spawn that clones, and to no other', async () => {
		const session = await startGitCredentialSession(
			[{ host: 'github.com', token: 'ghp_secret' }],
			GIT_CREDENTIAL_HELPER_PATH
		);
		try {
			// The clone spawn (`npm pack`) is handed the session env...
			const cloneEnv = await probeEnv(session.env);
			assert.ok(cloneEnv.includes('GIT_ASKPASS'), 'clone spawn can reach the helper');
			assert.ok(cloneEnv.includes(GIT_CREDENTIAL_SOCKET_ENV), 'clone spawn can reach the socket');

			// ...and the install spawn, where a transitive dependency's install script can run, is not.
			const installEnv = await probeEnv(undefined);
			assert.ok(!installEnv.includes(GIT_CREDENTIAL_SOCKET_ENV), 'install spawn cannot reach the socket');
			assert.ok(
				!installEnv.some((key) => key.startsWith('GIT_CONFIG_') || key === 'GIT_ASKPASS'),
				`install spawn saw git credential wiring: ${installEnv.join(', ')}`
			);
		} finally {
			await session.close();
		}
	});

	it('strips an inherited socket variable, disarming a helper wired up outside the session', async () => {
		// Belt and braces: even if Harper's own environment somehow carried the socket variable, a spawn
		// that was not granted the session must not inherit it.
		process.env[GIT_CREDENTIAL_SOCKET_ENV] = '/tmp/not-a-real-session.sock';
		try {
			const installEnv = await probeEnv(undefined);
			assert.ok(!installEnv.includes(GIT_CREDENTIAL_SOCKET_ENV), 'inherited socket variable stripped');
		} finally {
			delete process.env[GIT_CREDENTIAL_SOCKET_ENV];
		}
	});
});
