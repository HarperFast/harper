/**
 * harper#674 — deploying a component without restarting Harper leaves its routes
 * unregistered. Hitting the component's URL in that state must return a clean, actionable
 * 404 rather than an unhandled server error, and must not affect routing for components
 * that are already active.
 *
 * The actionable message is gated on two conditions:
 *   1. A restart is genuinely pending (`restartNeeded()` / get_status `restartRequired`). A
 *      `deploy_component` with `restart: false` now sets this flag itself (a deployed component
 *      is not live until a restart), so a fresh deploy-without-restart both reports
 *      restartRequired:true and surfaces the actionable 404. A directory under componentsRoot
 *      with no restart pending (e.g. an already-active component whose sub-path just doesn't
 *      match) falls back to the generic 404.
 *   2. The caller is an authenticated super_user (matching the existing `getComponents`
 *      boundary in utility/operation_authorization.ts) — otherwise the response difference
 *      (actionable vs. generic 404) is an oracle for which component directories exist on disk.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Inactive component 404', (ctx: ContextWithHarper) => {
	const NON_SU_ROLE = 'inactive_component_non_su_role';
	const NON_SU_USERNAME = 'inactive_component_non_su_user';
	const DEPLOYED = 'prometheus_exporter';

	before(async () => {
		// Pre-install a minimal already-active REST app so this represents a running Harper
		// instance (the scenario in harper#674), rather than a fresh boot with no REST handler
		// registered at all. Its directory (components/fixture-active-app) exists under
		// componentsRoot but it registers no routes, so any sub-path under it is a route miss.
		await setupHarperWithFixture(ctx, join(import.meta.dirname, 'fixture-active-app'));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function basicAuth() {
		return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	}

	async function restartRequired(): Promise<boolean> {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': basicAuth(), 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'get_status' }),
		});
		const body = await response.json();
		return body.restartRequired === true;
	}

	test('a component directory with NO restart pending gets a generic 404, not the actionable message', async () => {
		// At boot nothing has requested a restart, so restartNeeded() is false. fixture-active-app's
		// directory exists under componentsRoot but a route miss under it must not claim a restart
		// would activate anything.
		strictEqual(await restartRequired(), false);

		const response = await fetch(`${ctx.harper.httpURL}/fixture-active-app/not-a-route`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(response.status, 404);
		const body = await response.text();
		ok(
			!body.toLowerCase().includes('restart'),
			`without a pending restart the caller must get a generic 404, got: ${body}`
		);
	});

	test('redeploying an already-active component with restart:false does not itself request a restart', async () => {
		// Narrows deployComponent's restart-request to genuinely new components (harper#1806):
		// an existing, already-loaded component's own file watcher independently requests a
		// restart if a redeploy actually needs one, so deployComponent itself should stay quiet.
		//
		// fixture-active-app is a real, already-loaded component (from `before()`, loaded like any
		// normal boot -- not a deployed-but-never-restarted one), so it represents the "existing"
		// case. Its config.yaml sets only `rest: true`; server/REST.ts's handleApplication never
		// calls scope.handleEntry(), so this component has no file-watcher of its own. That means
		// nothing besides deployComponent's own requestRestart() call could flip restartRequired
		// here, so this is a clean, non-racy test of the narrowed gate in isolation.
		strictEqual(await restartRequired(), false);

		const payload = await targz(join(import.meta.dirname, 'fixture-active-app'));
		const deployResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'deploy_component',
				project: 'fixture-active-app',
				payload,
				restart: false,
			}),
		});
		strictEqual(deployResponse.status, 200);
		strictEqual(
			await restartRequired(),
			false,
			'redeploying an already-active component should not itself mark a restart as required'
		);
	});

	test('a fresh deploy_component with restart:false sets get_status restartRequired to true', async () => {
		const payload = await targz(join(import.meta.dirname, 'fixture-inactive-component'));
		const deployResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'deploy_component', project: DEPLOYED, payload, restart: false }),
		});
		strictEqual(deployResponse.status, 200);
		strictEqual(
			await restartRequired(),
			true,
			'deploying a component without restarting should mark a restart as required'
		);
	});

	test('the deployed-but-inactive component returns an actionable 404 for a super_user', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/${DEPLOYED}/metrics`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(response.status, 404);
		const body = await response.json();
		ok(
			body.title.includes(DEPLOYED) && body.title.toLowerCase().includes('restart'),
			`expected an actionable message naming '${DEPLOYED}' and mentioning a restart, got: ${JSON.stringify(body)}`
		);
	});

	test('add a non-super_user role and user', async () => {
		await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': basicAuth(), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'add_role',
				role: NON_SU_ROLE,
				permission: { super_user: false },
			}),
		}).then((r) => strictEqual(r.status, 200));
		await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': basicAuth(), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'add_user',
				role: NON_SU_ROLE,
				username: NON_SU_USERNAME,
				password: ctx.harper.admin.password,
				active: true,
			}),
		}).then((r) => strictEqual(r.status, 200));
	});

	test('a non-super_user caller gets a generic 404 even with a restart pending', async () => {
		// Restart is still pending from the deploy, and prometheus_exporter's directory still
		// exists, so the only thing withholding the actionable message here is the super_user gate.
		// Note: an *unauthenticated* loopback request can't exercise this path in this harness --
		// Harper's AUTHORIZE_LOCAL bypass treats 127.0.0.x/::1 requests as an implicit super_user
		// (security/auth.ts's `bypassUser ?? getSuperUser()` branch), so "no auth header" and
		// "super_user" are indistinguishable from a loopback integration test. Authenticating as a
		// real non-super_user role is what exercises the gate.
		strictEqual(await restartRequired(), true);
		const nonSuAuth = `Basic ${Buffer.from(`${NON_SU_USERNAME}:${ctx.harper.admin.password}`).toString('base64')}`;
		const response = await fetch(`${ctx.harper.httpURL}/${DEPLOYED}/metrics`, {
			headers: { Authorization: nonSuAuth },
		});
		strictEqual(response.status, 404);
		const body = await response.text();
		ok(
			!body.toLowerCase().includes('restart'),
			`a non-super_user caller must not see the actionable message, got: ${body}`
		);
	});

	test('a route that never existed still gets a generic 404', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/totally-bogus-path`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(response.status, 404);
	});

	test('a non-directory file directly under components root is not mistaken for a component', async () => {
		// Guards against a bare existence check (which can't tell a file from a directory)
		// reporting a false positive for a stray file like README.md or .DS_Store. Restart is
		// pending and the caller is super_user, so only the isDirectory() check withholds the
		// actionable message here.
		strictEqual(await restartRequired(), true);
		const componentsRoot = join(ctx.harper.dataRootDir, 'components');
		await mkdir(componentsRoot, { recursive: true });
		await writeFile(join(componentsRoot, 'README.md'), '# not a component\n');

		const response = await fetch(`${ctx.harper.httpURL}/README.md/whatever`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(response.status, 404);
		const contentType = response.headers.get('content-type') ?? '';
		ok(
			!contentType.includes('json'),
			`a plain file under components root must not produce the actionable message, got content-type: ${contentType}`
		);
	});

	test('node_modules and .deploy-aside directories under components root stay excluded', async () => {
		// These directories can legitimately exist under componentsRoot (npm dependency install,
		// deploy staging) but must never be reported as a deployed-but-inactive component. Restart
		// is pending and the caller is super_user, so only the name exclusion withholds the message.
		strictEqual(await restartRequired(), true);
		const componentsRoot = join(ctx.harper.dataRootDir, 'components');
		await mkdir(join(componentsRoot, 'node_modules', 'some-package'), { recursive: true });
		await mkdir(join(componentsRoot, '.deploy-aside', 'some-app'), { recursive: true });

		const nodeModulesResponse = await fetch(`${ctx.harper.httpURL}/node_modules/some-package`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(nodeModulesResponse.status, 404);
		ok(
			!(nodeModulesResponse.headers.get('content-type') ?? '').includes('json'),
			'node_modules must still get the generic 404, not the actionable message'
		);

		const asideResponse = await fetch(`${ctx.harper.httpURL}/.deploy-aside/some-app`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(asideResponse.status, 404);
		ok(
			!(asideResponse.headers.get('content-type') ?? '').includes('json'),
			'.deploy-aside must still get the generic 404, not the actionable message'
		);
	});
});
