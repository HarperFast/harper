/**
 * harper#674 — deploying a component without restarting Harper leaves its routes
 * unregistered. Hitting the component's URL in that state must return a clean, actionable
 * 404 rather than an unhandled server error, and must not affect routing for components
 * that are already active.
 *
 * The actionable message is gated on two conditions:
 *   1. A restart is genuinely pending (`restartNeeded()` / get_status `restartRequired`). A
 *      directory under componentsRoot only means "deployed but not yet active" when a restart
 *      is actually queued; otherwise the message would be a false claim (harper#674 review).
 *   2. The caller is an authenticated super_user (matching the existing `getComponents`
 *      boundary in utility/operation_authorization.ts) — otherwise the response difference
 *      (actionable vs. generic 404) is an oracle for which component directories exist on disk.
 *
 * Note: deploying a brand-new component with `restart: false` does NOT by itself set the
 * restart-needed flag (a never-loaded component has no file watcher, so nothing calls
 * requestRestart). The flag is set when an already-loaded component's watched files change.
 * These tests exercise both sides of the gate by toggling that real signal.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Inactive component 404', (ctx: ContextWithHarper) => {
	const NON_SU_ROLE = 'inactive_component_non_su_role';
	const NON_SU_USERNAME = 'inactive_component_non_su_user';
	const DEPLOYED = 'prometheus_exporter';

	before(async () => {
		// Pre-install a minimal already-active REST app so this represents a running Harper
		// instance (the scenario in harper#674), rather than a fresh boot with no REST handler
		// registered at all. It carries a jsResource file so it has a live file watcher, which
		// the tests use to toggle the real restart-needed signal.
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

	// Flip the real restart-needed signal by mutating a watched file in the already-loaded
	// active app. A never-loaded component has no watcher, so this is the realistic path by
	// which restartNeeded() becomes true. Polls get_status until the flag is observed (the
	// chokidar event -> requestRestart() hop is async) so the assertion below is deterministic.
	async function ensureRestartPending(): Promise<void> {
		const watched = join(ctx.harper.dataRootDir, 'components', 'fixture-active-app', 'resources.js');
		const contents = await readFile(watched, 'utf8');
		await writeFile(watched, `${contents}\n// touched at ${Date.now()}\n`);
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			if (await restartRequired()) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('timed out waiting for restartRequired to become true');
	}

	test('deploy the component (without restarting) so its directory exists but routes are inactive', async () => {
		const payload = await targz(join(import.meta.dirname, 'fixture-inactive-component'));
		const deployResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'deploy_component', project: DEPLOYED, payload, restart: false }),
		});
		strictEqual(deployResponse.status, 200);
	});

	test('a deployed component with NO restart pending gets a generic 404, not the actionable message', async () => {
		// No watched file has changed yet, so restartNeeded() is false. The deploy above left
		// prometheus_exporter's directory under componentsRoot, but without a pending restart we
		// must not claim a restart would activate it.
		strictEqual(await restartRequired(), false);

		const response = await fetch(`${ctx.harper.httpURL}/${DEPLOYED}/metrics`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(response.status, 404);
		const body = await response.text();
		ok(
			!body.toLowerCase().includes('restart'),
			`without a pending restart the caller must get a generic 404, got: ${body}`
		);
	});

	test('once a restart is pending, the same deployed-but-inactive component returns an actionable 404', async () => {
		await ensureRestartPending();

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
		// Restart is still pending from the earlier test, and prometheus_exporter's directory
		// still exists, so the only thing withholding the actionable message here is the
		// super_user gate. Note: an *unauthenticated* loopback request can't exercise this path
		// in this harness -- Harper's AUTHORIZE_LOCAL bypass treats 127.0.0.x/::1 requests as an
		// implicit super_user (security/auth.ts's `bypassUser ?? getSuperUser()` branch), so
		// "no auth header" and "super_user" are indistinguishable from a loopback integration
		// test. Authenticating as a real non-super_user role is what exercises the gate.
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
