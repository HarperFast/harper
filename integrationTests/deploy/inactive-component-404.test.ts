/**
 * harper#674 — deploying a component without restarting Harper leaves its routes
 * unregistered. Hitting the component's URL in that state must return a clean, actionable
 * 404 rather than an unhandled server error, and must not affect routing for components
 * that are already active.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';

import { setupHarperWithFixture, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Inactive component 404', (ctx: ContextWithHarper) => {
	before(async () => {
		// Pre-install a minimal already-active REST app so this represents a running Harper
		// instance (the scenario in harper#674), rather than a fresh boot with no REST handler
		// registered at all.
		await setupHarperWithFixture(ctx, join(import.meta.dirname, 'fixture-active-app'));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('deploying a component without restarting returns an actionable 404, not a crash', async () => {
		const project = 'prometheus_exporter';
		const auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		const payload = await targz(join(import.meta.dirname, 'fixture-inactive-component'));

		const deployResponse = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'deploy_component', project, payload, restart: false }),
		});
		strictEqual(deployResponse.status, 200);

		const response = await fetch(`${ctx.harper.httpURL}/${project}/metrics`, { headers: { Authorization: auth } });
		strictEqual(response.status, 404);
		const body = await response.json();
		ok(
			body.title.includes(project) && body.title.toLowerCase().includes('restart'),
			`expected an actionable message naming '${project}' and mentioning a restart, got: ${JSON.stringify(body)}`
		);
	});

	test('a route that never existed still gets a generic 404', async () => {
		const auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		const response = await fetch(`${ctx.harper.httpURL}/totally-bogus-path`, { headers: { Authorization: auth } });
		strictEqual(response.status, 404);
	});
});
