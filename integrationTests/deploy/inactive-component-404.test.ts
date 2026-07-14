/**
 * harper#674 — deploying a component without restarting Harper leaves its routes
 * unregistered. Hitting the component's URL in that state must return a clean, actionable
 * 404 rather than an unhandled server error, and must not affect routing for components
 * that are already active.
 *
 * The actionable message is only surfaced to an authenticated super_user (matching the
 * existing `getComponents` boundary in utility/operation_authorization.ts) — everyone else
 * gets the same generic 404 as a route that never existed, so the check can't be used as an
 * unauthenticated oracle for which component directories exist on disk.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Inactive component 404', (ctx: ContextWithHarper) => {
	const NON_SU_ROLE = 'inactive_component_non_su_role';
	const NON_SU_USERNAME = 'inactive_component_non_su_user';

	before(async () => {
		// Pre-install a minimal already-active REST app so this represents a running Harper
		// instance (the scenario in harper#674), rather than a fresh boot with no REST handler
		// registered at all.
		await setupHarperWithFixture(ctx, join(import.meta.dirname, 'fixture-active-app'));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function basicAuth() {
		return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	}

	test('deploying a component without restarting returns an actionable 404, not a crash', async () => {
		const project = 'prometheus_exporter';
		const payload = await targz(join(import.meta.dirname, 'fixture-inactive-component'));

		const deployResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'deploy_component', project, payload, restart: false }),
		});
		strictEqual(deployResponse.status, 200);

		const response = await fetch(`${ctx.harper.httpURL}/${project}/metrics`, {
			headers: { Authorization: basicAuth() },
		});
		strictEqual(response.status, 404);
		const body = await response.json();
		ok(
			body.title.includes(project) && body.title.toLowerCase().includes('restart'),
			`expected an actionable message naming '${project}' and mentioning a restart, got: ${JSON.stringify(body)}`
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

	test('a non-super_user caller gets a generic 404 for the same deployed-but-inactive component', async () => {
		// 'prometheus_exporter' was deployed (without restart) by the earlier test, so its
		// directory still exists under componentsRoot. Note: an *unauthenticated* loopback
		// request can't exercise this path in this harness -- Harper's AUTHORIZE_LOCAL bypass
		// treats requests from 127.0.0.x/::1 as an implicit super_user regardless of whether an
		// Authorization header is present (security/auth.ts's `bypassUser ?? getSuperUser()`
		// branch), so "no auth header" and "super_user" are indistinguishable from a loopback
		// integration test. Authenticating as a real non-super_user role is what actually
		// exercises the gate added for this fix.
		const nonSuAuth = `Basic ${Buffer.from(`${NON_SU_USERNAME}:${ctx.harper.admin.password}`).toString('base64')}`;
		const response = await fetch(`${ctx.harper.httpURL}/prometheus_exporter/metrics`, {
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
		// Guards against the `access`-only existence check (which can't tell a file from a
		// directory) reporting a false positive for a stray file like README.md or .DS_Store.
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
		// deploy staging) but must never be reported as a deployed-but-inactive component.
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
