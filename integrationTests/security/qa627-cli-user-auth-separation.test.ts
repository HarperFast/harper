/**
 * Promoted from qa-explorer (QA-627 / P-409): regression anchor for harper#1872, fixed by PR
 * harper#1873 ("fix(cli): separate transport auth from operation payload for add_user/alter_user").
 *
 * Invariant: for a networked CLI operation the HTTP Basic identity comes from a configured
 * credential source, never from the `username=`/`password=` args that are the add_user/alter_user
 * PAYLOAD. Pre-#1873 those args won the precedence chain, so the CLI authenticated as the user it
 * was creating — a 401 for add_user (that user does not exist yet) and for alter_user (the request
 * carried the new password as its credential), which made non-interactive user provisioning against
 * a deployed instance impossible.
 *
 * Pinned here: `auth_username=`/`auth_password=` win the auth leg; env-var credentials and
 * target-URL userinfo both beat the payload; each source is all-or-nothing, so an incomplete
 * explicit pair is fatal rather than completed from the next source; and the legacy payload
 * fallback survives for operations where those args genuinely ARE the credentials.
 * unitTests/bin/cliOperations.test.js owns the field-stripping half of the fix, which has no
 * server-observable effect.
 *
 * The suite drives dist/bin/harper.js as a child process, pinned via `harperBinPath` because
 * auto-resolution can pick up an unrelated `harper` package from node_modules.
 *
 * AUTHORIZELOCAL: the harness passes `--AUTHENTICATION_AUTHORIZELOCAL=true`, which auto-auths any
 * loopback caller as super_user and would make every arm here succeed regardless of what the CLI
 * sent. `config.authentication.authorizeLocal: false` reaches Harper through HARPER_SET_CONFIG and
 * overrides that CLI arg; the CONTROL test is the gate that proves it, and every other assertion in
 * this file is void if it fails.
 *
 * HERMETICITY: the CLI child runs with a throwaway HOME and cwd and an env scrubbed of
 * `HARPER_CLI_*`, `CLI_TARGET_*` and the workload-identity variables. Each is a credential source
 * outranking the legacy payload fallback, so any of them left in place would decide what the
 * fallback arms resolve to: a developer's saved `harper login` token in ~/.harperdb/credentials.json,
 * a repo-root `.env` (cliOperations() calls dotenv.config() before resolving auth), the env vars
 * themselves, and a CI runner's OIDC identity token.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/qa627-cli-user-auth-separation.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const execFileAsync = promisify(execFile);

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa627-cli-user-auth-separation');
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const skipSuite = process.platform === 'win32';

const ROLE = 'qa627_svc_role';
const ENV_AUTH_USER = 'qa627_env_created';
const ENV_AUTH_PW = 'Qa627-Env-Pw!1';
const ARGS_AUTH_USER = 'qa627_args_created';
const ARGS_AUTH_PW = 'Qa627-Args-Pw!1';
const URL_AUTH_USER = 'qa627_url_created';
const URL_AUTH_PW = 'Qa627-Url-Pw!1';
const FATAL_USER = 'qa627_never_created';
const LONE_USER = 'qa627_lone_username';
const ALTER_USER = 'qa627_alter_target';
const ALTER_PW_OLD = 'Qa627-Old-Pw!1';
const ALTER_PW_NEW = 'Qa627-New-Pw!1';

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

suite(
	'QA-627 CLI transport auth is separate from the add_user/alter_user payload (harper#1872)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let cliHome: string;

		/** A child process, never in-process: cliOperations() calls process.exit(). */
		async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
			const base: Record<string, string | undefined> = { ...process.env };
			for (const key of Object.keys(base)) {
				if (key.startsWith('HARPER_CLI_') || key.startsWith('CLI_TARGET_')) delete base[key];
			}
			// bin/workloadIdentity.ts: on an Actions runner with `id-token: write` these are set, and
			// the fallback arms would exchange an OIDC token instead of using the fallback.
			delete base.ACTIONS_ID_TOKEN_REQUEST_URL;
			delete base.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
			try {
				const { stdout, stderr } = await execFileAsync(process.execPath, [HARPER_BIN, ...args], {
					// dotenv.config() runs before auth resolution, so a repo-root `.env` would refill
					// what was just deleted.
					cwd: cliHome,
					env: { ...base, HOME: cliHome, USERPROFILE: cliHome, ...env },
					timeout: 20_000,
				});
				return { code: 0, stdout, stderr };
			} catch (err: any) {
				// A spawn failure puts a string in `code` (ENOENT and friends); keep the contract numeric
				// so an assertion diff reads as an exit status rather than a type mismatch.
				const code = typeof err.code === 'number' ? err.code : 1;
				const stderr =
					typeof err.code === 'string' ? `${err.code}: ${err.message}\n${err.stderr ?? ''}` : (err.stderr ?? '');
				return { code, stdout: err.stdout ?? '', stderr };
			}
		}

		/** `user_info` is a self lookup, so it needs no super_user permission. */
		async function canAuthenticate(username: string, password: string): Promise<number> {
			const header = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
			const res = await request(ctx.harper.operationsAPIURL)
				.post('/')
				.set('Authorization', header)
				.send({ operation: 'user_info' });
			return res.status;
		}

		async function listUsernames(): Promise<Set<string>> {
			const res = await client.req().send({ operation: 'list_users' }).expect(200);
			return new Set((res.body as any[]).map((u) => u.username));
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				harperBinPath: HARPER_BIN,
				config: { authentication: { authorizeLocal: false } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			// Under dataRootDir so instance teardown removes it, rather than a tmpdir entry that
			// leaks if this hook throws before `after` runs.
			cliHome = join(ctx.harper.dataRootDir, 'qa627-cli-home');
			await mkdir(cliHome, { recursive: true });

			let ready = false;
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/FirstTable/').timeout(2000);
					if (probe.status !== 404) {
						ready = true;
						break;
					}
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			assert.ok(ready, 'REST route /FirstTable/ never became available within 120s — the fixture did not install');

			await client
				.req()
				.send({ operation: 'add_role', role: ROLE, permission: { super_user: false } })
				.expect(200);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('CONTROL: a no-credentials ops-API call gets a genuine 401 (authorizeLocal bypass disabled)', async () => {
			const res = await request(ctx.harper.operationsAPIURL).post('/').send({ operation: 'describe_all' });
			console.log(`[QA-627][CONTROL] no-creds describe_all => ${res.status}`);
			assert.strictEqual(
				res.status,
				401,
				`AUTHORIZELOCAL ESCAPE (every assertion in this file is void if this fails): got ${res.status} ${res.text}`
			);
		});

		test('env-var credentials authenticate add_user, while username=/password= stay the payload', async () => {
			const { code, stdout, stderr } = await runCli(
				[
					'add_user',
					`target=${ctx.harper.operationsAPIURL}`,
					`username=${ENV_AUTH_USER}`,
					`password=${ENV_AUTH_PW}`,
					`role=${ROLE}`,
					'active=true',
				],
				{ HARPER_CLI_USERNAME: ctx.harper.admin.username, HARPER_CLI_PASSWORD: ctx.harper.admin.password }
			);
			console.log(`[QA-627][env-auth add_user] exit=${code}\nstdout=${stdout}\nstderr=${stderr}`);

			assert.strictEqual(
				code,
				0,
				`CLI add_user should authenticate as the env-var admin. stdout=${stdout} stderr=${stderr}`
			);
			assert.ok((await listUsernames()).has(ENV_AUTH_USER), `${ENV_AUTH_USER} should have been created`);
			// The payload password reached the BODY, not the Authorization header. Pre-#1873 this
			// arm 401'd before creating anything.
			assert.strictEqual(
				await canAuthenticate(ENV_AUTH_USER, ENV_AUTH_PW),
				200,
				`${ENV_AUTH_USER} should authenticate with the password passed as the add_user payload`
			);
		});

		test('auth_username=/auth_password= win the auth leg over both the payload and env vars', async () => {
			const { code, stdout, stderr } = await runCli(
				[
					'add_user',
					`target=${ctx.harper.operationsAPIURL}`,
					`auth_username=${ctx.harper.admin.username}`,
					`auth_password=${ctx.harper.admin.password}`,
					`username=${ARGS_AUTH_USER}`,
					`password=${ARGS_AUTH_PW}`,
					`role=${ROLE}`,
					'active=true',
				],
				// Wrong on purpose: without the dedicated args outranking them this call would 401.
				{ HARPER_CLI_USERNAME: 'qa627_not_a_user', HARPER_CLI_PASSWORD: 'Qa627-Wrong-Pw!1' }
			);
			console.log(`[QA-627][args-auth add_user] exit=${code}\nstdout=${stdout}\nstderr=${stderr}`);

			assert.strictEqual(code, 0, `auth_* args should have authenticated as admin. stdout=${stdout} stderr=${stderr}`);
			assert.ok((await listUsernames()).has(ARGS_AUTH_USER), `${ARGS_AUTH_USER} should have been created`);
			assert.strictEqual(
				await canAuthenticate(ARGS_AUTH_USER, ARGS_AUTH_PW),
				200,
				`${ARGS_AUTH_USER} should authenticate with its own payload password`
			);
		});

		test('admin credentials embedded in the target= URL authenticate add_user', async () => {
			const targetUrl = new URL(ctx.harper.operationsAPIURL);
			targetUrl.username = ctx.harper.admin.username;
			targetUrl.password = ctx.harper.admin.password;

			const { code, stdout, stderr } = await runCli([
				'add_user',
				`target=${targetUrl.toString()}`,
				`username=${URL_AUTH_USER}`,
				`password=${URL_AUTH_PW}`,
				`role=${ROLE}`,
				'active=true',
			]);
			console.log(`[QA-627][url-auth add_user] exit=${code}\nstdout=${stdout}\nstderr=${stderr}`);

			assert.strictEqual(
				code,
				0,
				`target= userinfo should have authenticated as admin. stdout=${stdout} stderr=${stderr}`
			);
			assert.ok((await listUsernames()).has(URL_AUTH_USER), `${URL_AUTH_USER} should have been created`);
			assert.strictEqual(
				await canAuthenticate(URL_AUTH_USER, URL_AUTH_PW),
				200,
				`${URL_AUTH_USER} should authenticate with its own payload password`
			);
		});

		test("alter_user applies the target user's new password instead of authenticating with it", async () => {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: ALTER_USER, password: ALTER_PW_OLD, active: true })
				.expect(200);
			assert.strictEqual(
				await canAuthenticate(ALTER_USER, ALTER_PW_OLD),
				200,
				'the alter target should authenticate with its original password before the CLI runs'
			);

			const { code, stdout, stderr } = await runCli(
				['alter_user', `target=${ctx.harper.operationsAPIURL}`, `username=${ALTER_USER}`, `password=${ALTER_PW_NEW}`],
				{ HARPER_CLI_USERNAME: ctx.harper.admin.username, HARPER_CLI_PASSWORD: ctx.harper.admin.password }
			);
			console.log(`[QA-627][env-auth alter_user] exit=${code}\nstdout=${stdout}\nstderr=${stderr}`);

			assert.strictEqual(
				code,
				0,
				`CLI alter_user should authenticate as the env-var admin. stdout=${stdout} stderr=${stderr}`
			);
			assert.strictEqual(
				await canAuthenticate(ALTER_USER, ALTER_PW_NEW),
				200,
				'the new password should now authenticate — alter_user must have been applied'
			);
			assert.strictEqual(
				await canAuthenticate(ALTER_USER, ALTER_PW_OLD),
				401,
				'the old password must no longer authenticate'
			);
		});

		test('an incomplete auth_* pair is a hard error, never completed from another source', async () => {
			const { code, stdout, stderr } = await runCli(
				[
					'add_user',
					`target=${ctx.harper.operationsAPIURL}`,
					`auth_username=${ctx.harper.admin.username}`,
					`username=${FATAL_USER}`,
					`password=Qa627-Fatal-Pw!1`,
					`role=${ROLE}`,
					'active=true',
				],
				// Composing across sources would pair auth_username with the env password and succeed.
				{ HARPER_CLI_USERNAME: ctx.harper.admin.username, HARPER_CLI_PASSWORD: ctx.harper.admin.password }
			);
			console.log(`[QA-627][incomplete auth_*] exit=${code}\nstdout=${stdout}\nstderr=${stderr}`);

			assert.notStrictEqual(code, 0, `a lone auth_username= must fail. stdout=${stdout} stderr=${stderr}`);
			assert.match(
				stdout + stderr,
				/incomplete credentials/i,
				`expected an incomplete-credentials error, got stdout=${stdout} stderr=${stderr}`
			);
			assert.ok(!(await listUsernames()).has(FATAL_USER), `${FATAL_USER} must not have been created`);
		});

		test('the legacy username=/password= fallback still authenticates an operation where they ARE the credentials', async () => {
			const both = await runCli([
				'describe_all',
				`target=${ctx.harper.operationsAPIURL}`,
				`username=${ctx.harper.admin.username}`,
				`password=${ctx.harper.admin.password}`,
			]);
			console.log(`[QA-627][payload fallback] exit=${both.code}\nstderr=${both.stderr}`);
			// The compatibility promise, not the collision fix: this passed pre-#1873 too. It fails
			// only if the fallback is dropped outright.
			assert.strictEqual(
				both.code,
				0,
				`the legacy username=/password= fallback should still authenticate describe_all. stdout=${both.stdout} stderr=${both.stderr}`
			);
		});

		test('a lone username= stays payload, leaving configured credentials in charge of the request', async () => {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: LONE_USER, password: 'Qa627-Lone-Pw!1', active: true })
				.expect(200);

			// The env pair is what makes the two polarities distinguishable: pre-#1873 `req.username`
			// outranked it and the drop 401'd as a passwordless LONE_USER; now the env pair wins and
			// the drop succeeds as admin. With no credentials at all both polarities 401, so that
			// shape cannot detect a revert.
			const { code, stdout, stderr } = await runCli(
				['drop_user', `target=${ctx.harper.operationsAPIURL}`, `username=${LONE_USER}`],
				{ HARPER_CLI_USERNAME: ctx.harper.admin.username, HARPER_CLI_PASSWORD: ctx.harper.admin.password }
			);
			console.log(`[QA-627][lone username=] exit=${code}\nstdout=${stdout}\nstderr=${stderr}`);

			assert.strictEqual(
				code,
				0,
				`a lone username= must stay payload and leave the env credentials in charge. stdout=${stdout} stderr=${stderr}`
			);
			assert.ok(!(await listUsernames()).has(LONE_USER), `${LONE_USER} should have been dropped`);
		});
	}
);
