/**
 * `harper deploy setup=true provider=github-actions` against a real Harper, through the real CLI.
 *
 * Invariant: setup leaves a deploy-only role, an active user in it, and an enabled trust policy whose
 * issuer, audience and claims are exactly what a matching GitHub Actions run presents — and it only
 * ever creates. A rerun changes nothing; a record that differs, or that someone disabled, stops setup
 * before it writes, so setup can neither repurpose a role nor undo a revocation.
 *
 * `gh` is kept off PATH and `repository_id=` is given, so no run touches the network. Without `gh`
 * the GitHub variable cannot be set, so every run here exits 1 after the cluster part, and says so.
 *
 * Unit coverage of the derivations and the reconcile decision: unitTests/bin/deploySetupGithubActions.test.js.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/deploy-setup-github-actions.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const execFileAsync = promisify(execFile);

const FIXTURE_PATH = resolve(import.meta.dirname, 'deploy-setup-github-actions');
const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
const skipSuite = process.platform === 'win32';

const COMPONENT = 'web';
const NAME = `${COMPONENT}-ci-deploy`;
const POLICY = `github-actions-${COMPONENT}`;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

suite('harper deploy setup=true provider=github-actions', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let cliHome: string;
	let audience: string;

	/** A child process: cliOperations() calls process.exit(). */
	async function runSetup(args: string[], cwd = cliHome): Promise<CliResult> {
		const base: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(base)) {
			if (key.startsWith('HARPER_CLI_') || key.startsWith('CLI_TARGET_')) delete base[key];
		}
		delete base.ACTIONS_ID_TOKEN_REQUEST_URL;
		delete base.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
		delete base.NODE_OPTIONS;
		delete base.DOTENV_CONFIG_PATH;
		const setupArgs = [
			'deploy',
			'setup=true',
			'provider=github-actions',
			`target=${ctx.harper.operationsAPIURL}`,
			'repo=acme/web',
			'repository_id=67890',
			...args,
		];
		try {
			const { stdout, stderr } = await execFileAsync(process.execPath, [HARPER_BIN, ...setupArgs], {
				cwd,
				env: {
					...base,
					HOME: cliHome,
					USERPROFILE: cliHome,
					// Only node's own directory: no `gh`, so nothing reaches GitHub.
					PATH: dirname(process.execPath),
					HARPER_CLI_USERNAME: ctx.harper.admin.username,
					HARPER_CLI_PASSWORD: ctx.harper.admin.password,
				},
				timeout: 30_000,
			});
			return { code: 0, stdout, stderr };
		} catch (err: any) {
			const code = typeof err.code === 'number' ? err.code : 1;
			return { code, stdout: err.stdout ?? '', stderr: err.stderr ?? `${err.code}: ${err.message}` };
		}
	}

	async function op(body: Record<string, unknown>) {
		return (await client.req().send(body).expect(200)).body;
	}

	const findRole = async () => ((await op({ operation: 'list_roles' })) as any[]).find((r) => r.role === NAME);
	const findUser = async () => ((await op({ operation: 'list_users' })) as any[]).find((u) => u.username === NAME);
	const findPolicy = async () =>
		((await op({ operation: 'list_oidc_trust' })).policies as any[]).find((p) => p.id === POLICY);

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			harperBinPath: HARPER_BIN,
			config: { authentication: { authorizeLocal: false } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		cliHome = join(ctx.harper.dataRootDir, 'deploy-setup-cli-home');
		await mkdir(cliHome, { recursive: true });
		await waitForRouteReady(client, '/FirstTable/', 120_000);
		const url = new URL(ctx.harper.operationsAPIURL);
		audience = `${url.protocol}//${url.hostname}:${url.port}/`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('CONTROL: a no-credentials call is refused, so setup authenticates as the admin it is given', async () => {
		const res = await request(ctx.harper.operationsAPIURL).post('/').send({ operation: 'describe_all' });
		assert.strictEqual(res.status, 401, `authorizeLocal escape: got ${res.status} ${res.text}`);
	});

	test('creates the role, user and policy the workflow needs, then reports the unset variable', async () => {
		const { code, stdout, stderr } = await runSetup([`project=${COMPONENT}`]);
		assert.strictEqual(code, 1, `expected exit 1 (no gh). stdout=${stdout} stderr=${stderr}`);
		assert.match(stdout, new RegExp(`Created role ${NAME}, user ${NAME}, trust policy ${POLICY}`));
		assert.match(stderr, /The cluster is set up, but the HARPER_CLI_TARGET repository variable was not set/);
		assert.match(stderr, new RegExp(`gh variable set HARPER_CLI_TARGET --repo acme/web --body ${audience}`));

		const role = await findRole();
		assert.deepStrictEqual(role.permission.operations.sort(), ['deploy_component', 'get_job']);
		assert.notStrictEqual(role.permission.super_user, true);

		const user = await findUser();
		assert.strictEqual(user.role.role, NAME);
		assert.strictEqual(user.active, true);

		const policy = await findPolicy();
		assert.strictEqual(policy.issuer, 'https://token.actions.githubusercontent.com');
		assert.strictEqual(policy.audience, audience);
		assert.strictEqual(policy.user, NAME);
		assert.deepStrictEqual(policy.claims, {
			repository_id: '67890',
			workflow_ref: 'acme/web/.github/workflows/deploy.yaml@refs/heads/main',
			environment: 'production',
		});
		assert.deepStrictEqual(policy.operations.sort(), ['deploy_component', 'get_job']);
		assert.strictEqual(policy.enabled, true);
		assert.ok(!policy.invalid_reason, `unexpected invalid_reason: ${policy.invalid_reason}`);
	});

	test('a rerun changes nothing', async () => {
		const before = { role: await findRole(), user: await findUser(), policy: await findPolicy() };
		const { code, stdout } = await runSetup([`project=${COMPONENT}`]);
		assert.strictEqual(code, 1);
		assert.match(stdout, /Everything already matched; nothing was changed/);
		assert.deepStrictEqual({ role: await findRole(), user: await findUser(), policy: await findPolicy() }, before);
	});

	test('the role can poll its job but cannot read data or run other operations', async () => {
		const password = 'Deploy-Setup-Test-Pw1';
		await op({ operation: 'alter_user', username: NAME, password });
		const header = 'Basic ' + Buffer.from(`${NAME}:${password}`).toString('base64');
		const call = (body: Record<string, unknown>) =>
			request(ctx.harper.operationsAPIURL).post('/').set('Authorization', header).send(body);

		assert.strictEqual((await call({ operation: 'get_job', id: '00000000-0000-4000-8000-000000000000' })).status, 200);
		assert.strictEqual((await call({ operation: 'describe_all' })).status, 403);
		assert.strictEqual((await call({ operation: 'search_by_id', table: 'FirstTable', ids: ['1'] })).status, 403);
	});

	test('a role that grants more stops setup before it writes, and is left as it was', async () => {
		const role = await findRole();
		const widened = { ...role.permission, operations: ['deploy_component', 'get_job', 'add_user'] };
		await op({ operation: 'alter_role', id: role.id, role: NAME, permission: widened });
		const policyBefore = await findPolicy();

		const { code, stderr } = await runSetup([`project=${COMPONENT}`]);
		assert.strictEqual(code, 1);
		assert.match(stderr, /Nothing was changed/);
		assert.match(stderr, new RegExp(`Role "${NAME}" already exists and its operations are`));
		assert.deepStrictEqual((await findRole()).permission.operations.sort(), [
			'add_user',
			'deploy_component',
			'get_job',
		]);
		assert.deepStrictEqual(await findPolicy(), policyBefore);

		await op({ operation: 'alter_role', id: role.id, role: NAME, permission: role.permission });
	});

	test('a deactivated user stays deactivated: setup does not undo a revocation', async () => {
		await op({ operation: 'alter_user', username: NAME, active: false });
		const { code, stderr } = await runSetup([`project=${COMPONENT}`]);
		assert.strictEqual(code, 1);
		assert.match(stderr, new RegExp(`User "${NAME}" already exists and it is inactive`));
		assert.strictEqual((await findUser()).active, false);
		await op({ operation: 'alter_user', username: NAME, active: true });
	});

	test('a workflow file that cannot match stops setup before it creates anything', async () => {
		const checkout = join(cliHome, 'mismatched-checkout');
		await mkdir(join(checkout, '.github', 'workflows'), { recursive: true });
		await writeFile(
			join(checkout, '.github', 'workflows', 'deploy.yaml'),
			'on:\n  push:\n    branches: [release]\njobs:\n  deploy:\n    environment: production\n'
		);
		const { code, stderr } = await runSetup(['project=other'], checkout);
		assert.strictEqual(code, 1);
		assert.match(stderr, /deploy\.yaml cannot match the trust policy: it deploys on pushes to release, not "main"/);
		const roles = (await op({ operation: 'list_roles' })) as any[];
		assert.ok(!roles.some((r) => r.role === 'other-ci-deploy'), 'no role should have been created');
	});
});
