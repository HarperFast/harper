/**
 * End-to-end anchor for harper#1927 and harper#1928: neither the working directory's `.env` nor a
 * login server's reply picks where the CLI sends credentials or which target a saved token belongs to.
 *
 * Needs no Harper instance: the two loopback stub endpoints record what reached them. The developer's
 * own login and shell must not decide the outcome, hence the throwaway HOME/cwd and the scrubbed env.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/cli-target-credential-trust.test.ts"
 */
import { suite, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');

const SCRUBBED = new Set([
	'HARPER_CLI_TARGET',
	'CLI_TARGET',
	'ACTIONS_ID_TOKEN_REQUEST_URL',
	'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
	'GITHUB_REPOSITORY',
	'GITHUB_SHA',
	'GITHUB_REF',
	'GITHUB_EVENT_PATH',
	'NODE_TLS_REJECT_UNAUTHORIZED',
	'NODE_USE_ENV_PROXY',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NODE_OPTIONS',
	'DOTENV_CONFIG_PATH',
	'DOTENV_KEY',
]);

function unsignedJwt(payload: object): string {
	const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
	return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

const OPERATION_TOKEN = unsignedJwt({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 });
const REFRESH_TOKEN = 'synthetic-refresh-token';
const PASSWORD = 'synthetic-password-1927';

interface Received {
	operation: string;
	authorization?: string;
}

interface Endpoint {
	url: string;
	received: Received[];
	close(): Promise<void>;
}

async function startEndpoint(spoofTarget?: () => string): Promise<Endpoint> {
	const received: Received[] = [];
	const server: Server = createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			let operation = '';
			try {
				operation = JSON.parse(body).operation;
			} catch {}
			received.push({ operation, authorization: req.headers.authorization });
			res.setHeader('Content-Type', 'application/json');
			if (operation === 'create_authentication_tokens') {
				const target = spoofTarget?.();
				res.end(
					JSON.stringify({
						operation_token: OPERATION_TOKEN,
						refresh_token: REFRESH_TOKEN,
						target,
						resolvedTarget: target,
					})
				);
			} else {
				res.end(JSON.stringify({ ok: true }));
			}
		});
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		received,
		close: () => new Promise((done) => server.close(() => done())),
	};
}

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

suite('CLI target and saved credentials are chosen by the client (harper#1927, harper#1928)', () => {
	let intended: Endpoint;
	let elsewhere: Endpoint;
	let home: string;
	let project: string;

	async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
		const base: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(base)) {
			const upper = key.toUpperCase();
			if (SCRUBBED.has(upper) || upper.startsWith('HARPER_CLI_') || upper.startsWith('CLI_TARGET_')) delete base[key];
		}
		try {
			const { stdout, stderr } = await execFileAsync(process.execPath, [HARPER_BIN, ...args], {
				cwd: project,
				env: { ...base, HOME: home, USERPROFILE: home, ...env },
				timeout: 30_000,
			});
			return { code: 0, stdout, stderr };
		} catch (err: any) {
			const code = typeof err.code === 'number' ? err.code : 1;
			return {
				code,
				stdout: err.stdout ?? '',
				stderr: `${typeof err.code === 'string' ? err.code : ''}${err.stderr ?? ''}`,
			};
		}
	}

	async function savedCredentials(): Promise<any> {
		return JSON.parse(await readFile(join(home, '.harperdb', 'credentials.json'), 'utf8'));
	}

	async function loginToIntended(extraArgs: string[] = []): Promise<CliResult> {
		return runCli(['login', ...extraArgs, intended.url, 'admin'], { HARPER_CLI_PASSWORD: PASSWORD });
	}

	before(async () => {
		elsewhere = await startEndpoint();
		intended = await startEndpoint(() => elsewhere.url);
	});

	after(async () => {
		await intended.close();
		await elsewhere.close();
	});

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), 'harper-cli-trust-'));
		project = join(home, 'project');
		await mkdir(project);
		intended.received.length = 0;
		elsewhere.received.length = 0;
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	test('login saves the token under the URL it connected to, and the next bare command goes there', async () => {
		await writeFile(join(project, '.env'), 'APP_SETTING=1\n');
		const login = await loginToIntended();
		assert.strictEqual(login.code, 0, `login failed: ${login.stderr}`);
		assert.ok(login.stdout.includes(`Successfully logged in to ${intended.url}`), login.stdout);

		const credentials = await savedCredentials();
		assert.deepStrictEqual(Object.keys(credentials.targets), [intended.url]);
		assert.strictEqual(credentials.last_target, intended.url);
		assert.strictEqual(await readFile(join(project, '.env'), 'utf8'), 'APP_SETTING=1\n');

		const op = await runCli(['describe_all']);
		assert.strictEqual(op.code, 0, `describe_all failed: ${op.stderr}`);
		assert.deepStrictEqual(
			intended.received.map((r) => r.operation),
			['create_authentication_tokens', 'describe_all']
		);
		assert.strictEqual(intended.received[1].authorization, `Bearer ${OPERATION_TOKEN}`);
		assert.deepStrictEqual(elsewhere.received, []);
	});

	test('login --for-ci emits the URL it connected to', async () => {
		const login = await loginToIntended(['--for-ci']);
		assert.strictEqual(login.code, 0, `login failed: ${login.stderr}`);
		assert.strictEqual(login.stdout, `HARPER_CLI_TARGET=${intended.url}\nHARPER_CLI_REFRESH_TOKEN=${REFRESH_TOKEN}\n`);
		assert.ok(!login.stderr.includes(elsewhere.url), login.stderr);
	});

	test('a project .env target stops the command before anything is sent', async () => {
		assert.strictEqual((await loginToIntended()).code, 0);
		intended.received.length = 0;
		await writeFile(join(project, '.env'), `HARPER_CLI_TARGET=${elsewhere.url}\n`);

		const op = await runCli(['add_user', 'username=new_user', `password=${PASSWORD}`, 'role=r']);
		assert.notStrictEqual(op.code, 0);
		assert.match(op.stderr, /HARPER_CLI_TARGET must not come from/);
		assert.ok(!op.stderr.includes(PASSWORD), op.stderr);
		assert.deepStrictEqual(elsewhere.received, []);
		assert.deepStrictEqual(intended.received, []);
	});

	test('a project .env password stops login before it prompts or connects', async () => {
		await writeFile(join(project, '.env'), `HARPER_CLI_PASSWORD=${PASSWORD}\n`);
		const login = await runCli(['login', intended.url, 'admin']);
		assert.notStrictEqual(login.code, 0);
		assert.match(login.stderr, /HARPER_CLI_PASSWORD must not come from/);
		assert.ok(!login.stderr.includes(PASSWORD), login.stderr);
		assert.deepStrictEqual(intended.received, []);
	});

	test('a project .env target stops a backup command instead of running it on local files', async () => {
		await writeFile(join(project, '.env'), `HARPER_CLI_TARGET=${elsewhere.url}\n`);
		const backup = await runCli(['delete_backup', 'backup_id=1']);
		assert.notStrictEqual(backup.code, 0);
		assert.match(backup.stderr, /HARPER_CLI_TARGET must not come from/);
		assert.deepStrictEqual(elsewhere.received, []);
	});

	test('an exported target is still honoured, over a conflicting .env value', async () => {
		await writeFile(join(project, '.env'), `HARPER_CLI_TARGET=${intended.url}\n`);
		const op = await runCli(['describe_all'], { HARPER_CLI_TARGET: elsewhere.url });
		assert.strictEqual(op.code, 0, `describe_all failed: ${op.stderr}`);
		assert.deepStrictEqual(
			elsewhere.received.map((r) => r.operation),
			['describe_all']
		);
		assert.deepStrictEqual(intended.received, []);
	});
});
