/**
 * Invariant: setup leaves an identity that can deploy previews of its application within the grant's bounds, and
 * nothing else (harper#3042).
 *
 * `gh` is kept off PATH and the repository doesn't exist, so the lookup finds nothing and `repository_id=` is used;
 * without `gh` the repository variable cannot be set, so setup exits 1 after the cluster part. The created user signs
 * in with a password the test sets; the OIDC exchange is covered in unit tests.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/deploy/preview-setup.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

const HARPER_BIN = resolve(import.meta.dirname, '../../dist/bin/harper.js');
// GitHub owner names can't contain `_`, so this repository can never exist and its lookup finds nothing.
const REPO = 'preview_setup_fixture/shop';
// `.invalid` never resolves, so the deploy's reachability check has a reason to report.
const DOMAIN = 'app.qa.invalid';
const PREVIEW_PASSWORD = 'Preview-Setup-Test-Pw1';
// Windows has no UDS mirrors, so admission refuses a dedicated worker there; the Bun listener path is not yet exercised.
const UNSUPPORTED_HERE = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

suite('harper preview setup and teardown (harper#3042)', { skip: UNSUPPORTED_HERE }, (ctx: ContextWithHarper) => {
	let home: string;
	let source: string;
	let payload: string;

	const adminAuth = () => ({
		HARPER_CLI_USERNAME: ctx.harper.admin.username,
		HARPER_CLI_PASSWORD: ctx.harper.admin.password,
	});
	const previewAuth = { HARPER_CLI_USERNAME: 'shop-ci-preview', HARPER_CLI_PASSWORD: PREVIEW_PASSWORD };

	/** A child process: cliOperations() calls process.exit(). */
	async function harper(
		args: string[],
		{ cwd = home, env = adminAuth() as Record<string, string> } = {}
	): Promise<CliResult> {
		const base: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(base)) {
			if (key.startsWith('HARPER_CLI_') || key.startsWith('CLI_TARGET_') || key.startsWith('GITHUB_')) delete base[key];
		}
		delete base.ACTIONS_ID_TOKEN_REQUEST_URL;
		delete base.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
		delete base.NODE_OPTIONS;
		delete base.DOTENV_CONFIG_PATH;
		try {
			const { stdout, stderr } = await promisify(execFile)(
				process.execPath,
				[HARPER_BIN, ...args, `target=${ctx.harper.operationsAPIURL}`],
				{
					cwd,
					// Only node's own directory: no `gh` and no `git`, so nothing reaches GitHub.
					env: { ...base, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), ...env },
					timeout: 120_000,
				}
			);
			return { code: 0, stdout, stderr };
		} catch (error: any) {
			return {
				code: typeof error.code === 'number' ? error.code : 1,
				stdout: error.stdout ?? '',
				stderr: error.stderr ?? `${error.code}: ${error.message}`,
			};
		}
	}

	const setup = (app: string, extra: string[] = [], options?: Parameters<typeof harper>[1]) =>
		harper(
			['preview', 'setup', `app=${app}`, `repo=${REPO}`, 'repository_id=67890', `domain=${DOMAIN}`, ...extra],
			options
		);

	async function operation(
		body: Record<string, unknown>,
		[username, password] = [ctx.harper.admin.username, ctx.harper.admin.password]
	): Promise<{ status: number; body: any }> {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
			},
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json().catch(() => undefined) };
	}
	/** As an administrator; the request must succeed. */
	async function sendOperation(body: Record<string, unknown>): Promise<any> {
		const { status, body: answer } = await operation(body);
		strictEqual(status, 200, `${body.operation}: ${JSON.stringify(answer)}`);
		return answer;
	}
	/** The operations API as the preview identity, which a run of the preview workflow acts as. */
	const asPreviewUser = (body: Record<string, unknown>) => operation(body, ['shop-ci-preview', PREVIEW_PASSWORD]);

	const policyOf = (app: string) => sendOperation({ operation: 'get_preview_policy', app });

	before(async () => {
		home = await mkdtemp(join(tmpdir(), 'preview-setup-'));
		source = join(home, 'shop');
		await mkdir(source, { recursive: true });
		await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'shop', version: '1.0.0' }));
		await writeFile(join(source, 'config.yaml'), 'rest: true\njsResource:\n  files: resources.js\n');
		await writeFile(
			join(source, 'resources.js'),
			"export class Probe extends Resource { get() { return { application: 'preview' }; } }\n"
		);
		payload = await targz(source);
		await startHarper(ctx, {
			config: {
				authentication: { authorizeLocal: false },
				threads: { count: 1, maxIsolated: 2 },
				tls: { unixDomainSockets: true },
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(home, { recursive: true, force: true });
	});

	test('a workflow that would run for fork pull requests stops setup before it writes anything', async () => {
		const checkout = join(home, 'unsafe-checkout');
		await mkdir(join(checkout, '.github', 'workflows'), { recursive: true });
		await writeFile(
			join(checkout, '.github', 'workflows', 'preview.yaml'),
			'on: pull_request_target\njobs:\n  deploy:\n    environment: preview\n    permissions:\n      id-token: write\n'
		);
		// No git on the child's PATH, so the checkout names its repository the way a CI runner does.
		const { code, stderr } = await setup('unsafe', [], {
			cwd: checkout,
			env: { ...adminAuth(), GITHUB_REPOSITORY: REPO },
		});
		strictEqual(code, 1);
		match(stderr, /preview\.yaml cannot be used for previews: job "deploy" runs for pull requests from forks/);
		const policy = await policyOf('unsafe');
		strictEqual(policy.enabled, false);
		ok(policy.problems.includes('role "unsafe-ci-preview" is missing'));

		// A job that only needs another, which never checks for forks either, cannot be verified safe.
		await writeFile(
			join(checkout, '.github', 'workflows', 'preview.yaml'),
			'on: pull_request_target\njobs:\n  build:\n    runs-on: ubuntu-latest\n  deploy:\n    needs: [build]\n' +
				'    environment: preview\n    permissions:\n      id-token: write\n'
		);
		const unverified = await setup('unsafe', [], { cwd: checkout, env: { ...adminAuth(), GITHUB_REPOSITORY: REPO } });
		strictEqual(unverified.code, 1);
		match(unverified.stderr, /setup could not verify that job "deploy" excludes fork pull requests/);
		strictEqual((await policyOf('unsafe')).enabled, false);
	});

	test('creates the identity, writes the starter workflow, and reports the unset variable', async () => {
		const checkout = join(home, 'shop-checkout');
		await mkdir(checkout, { recursive: true });
		const { code, stdout, stderr } = await setup('shop', ['maxPreviews=1', 'maxTtlDays=2', 'write_workflow=true'], {
			cwd: checkout,
			env: { ...adminAuth(), GITHUB_REPOSITORY: REPO },
		});
		strictEqual(code, 1, `expected exit 1 (no gh). stdout=${stdout} stderr=${stderr}`);
		match(stdout, /can deploy previews of shop/);
		match(stdout, /created role shop-ci-preview, user shop-ci-preview, trust policy github-actions-shop-preview/);
		match(stdout, /Wrote \.github\/workflows\/preview\.yaml/);
		match(stderr, /the HARPER_PREVIEW_TARGET repository variable was not set/);

		const workflow = await readFile(join(checkout, '.github', 'workflows', 'preview.yaml'), 'utf8');
		match(
			workflow,
			/harper preview deploy app=shop pr="\$PR" branch="\$BRANCH" by_ref=true ref="\$SHA" domain=app\.qa\.invalid/
		);

		const policy = await policyOf('shop');
		strictEqual(policy.enabled, true, JSON.stringify(policy.problems));
		deepStrictEqual(policy.grant, {
			names: ['shop-pr-*'],
			constraints: {
				isolated: true,
				hostSuffix: `.${DOMAIN}`,
				branchedDatabases: 'required',
				preview: 'required',
				maxPreviews: 1,
				maxTtlDays: 2,
			},
		});
		strictEqual(policy.branch, 'main');
		strictEqual(policy.repository, REPO);

		// A rerun from the same checkout checks the workflow it wrote, and changes nothing.
		const rerun = await setup('shop', ['maxPreviews=1', 'maxTtlDays=2'], {
			cwd: checkout,
			env: { ...adminAuth(), GITHUB_REPOSITORY: REPO },
		});
		strictEqual(rerun.code, 1);
		match(rerun.stdout, /already enabled; nothing changed/);
	});

	test('harper preview deploy, as the created user, deploys a preview within the grant', async () => {
		await sendOperation({
			operation: 'alter_user',
			username: 'shop-ci-preview',
			password: PREVIEW_PASSWORD,
		});
		const { code, stdout, stderr } = await harper(
			['preview', 'deploy', 'app=shop', 'pr=12', 'branch=fix/cart', `domain=${DOMAIN}`, 'ttl=30'],
			{
				cwd: source,
				env: previewAuth,
			}
		);
		strictEqual(code, 0, `stdout=${stdout} stderr=${stderr}`);
		match(stdout, new RegExp(`Preview: https://fix-cart\\.${DOMAIN.replaceAll('.', '\\.')}/`));
		match(stderr, /warning: the preview deployed, but/);

		const entry = (await sendOperation({ operation: 'get_components' })).entries.find(
			(component: any) => component.name === 'shop-pr-12'
		);
		strictEqual(entry.host, `fix-cart.${DOMAIN}`);
		const expiresAt = Date.parse(entry.preview.expiresAt);
		ok(
			expiresAt <= Date.now() + 2 * 24 * 60 * 60 * 1000,
			`ttl=30 is clamped to maxTtlDays: ${entry.preview.expiresAt}`
		);
	});

	test('the grant refuses what is not a preview of shop, and a second preview past the cap', async () => {
		for (const [body, status, message] of [
			[{ project: 'shop', isolated: true, host: `shop.${DOMAIN}`, branchedDatabases: true }, 403, /not covered/],
			[{ project: 'docs-pr-1', isolated: true, host: `docs.${DOMAIN}`, branchedDatabases: true }, 403, /not covered/],
			[
				{
					project: 'shop-pr-13',
					isolated: true,
					host: `other.${DOMAIN}`,
					branchedDatabases: true,
					preview: { app: 'shop', pr: 13, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
				},
				409,
				/oldest is 'shop-pr-12'/,
			],
			[{ project: 'shop-pr-14', isolated: true, host: 'pr.example.com', branchedDatabases: true }, 403, /host under/],
		] as const) {
			const { status: actual, body: answer } = await asPreviewUser({
				operation: 'deploy_component',
				payload,
				restart: true,
				...body,
			});
			strictEqual(actual, status, `${body.project}: ${JSON.stringify(answer)}`);
			match(JSON.stringify(answer), message);
		}
		strictEqual((await asPreviewUser({ operation: 'describe_all' })).status, 403);
		strictEqual((await asPreviewUser({ operation: 'enable_previews', app: 'docs' })).status, 403);
	});

	test('harper preview teardown drops the preview and removes the identity', async () => {
		const { code, stdout, stderr } = await harper(['preview', 'teardown', 'app=shop']);
		strictEqual(code, 0, `stdout=${stdout} stderr=${stderr}`);
		match(stdout, /Disabled previews of shop/);
		match(stdout, /shop-pr-12: \S+ dropped/);
		match(
			stdout,
			/Removed trust policy github-actions-shop-preview, trust policy github-actions-shop-preview-cleanup, user shop-ci-preview, role shop-ci-preview/
		);

		const entries = (await sendOperation({ operation: 'get_components' })).entries;
		ok(!entries.some((component: any) => component.name === 'shop-pr-12'));
		const policy = await policyOf('shop');
		strictEqual(policy.enabled, false);
		strictEqual(policy.trust.length, 0);
		strictEqual((await asPreviewUser({ operation: 'get_components' })).status, 401);
	});
});
