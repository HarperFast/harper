/**
 * Local application deployment test.
 *
 * Deploys an application from a fixture directory using the `payload` parameter of
 * the `deploy_component` Operations API call. Verifies that the application is
 * deployed correctly and can be accessed via HTTP.
 *
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Local application deployment', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('verify Harper', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
		const body = await response.text();
		strictEqual(body, 'Harper is running.');
	});

	test('deploy application', async () => {
		const project = 'test-application';
		const payload = await targz(join(import.meta.dirname, 'fixture'));
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'deploy_component',
				project,
				payload,
				restart: true,
			}),
		});
		strictEqual(response.status, 200);
		const body = await response.json();
		deepStrictEqual(body, { message: 'Successfully deployed: test-application, restarting Harper' });
		await sleep(5000);
		ok(existsSync(join(ctx.harper.dataRootDir, 'components', project)));
		ok(existsSync(join(ctx.harper.dataRootDir, 'harper-application-lock.json')));
	});

	test('access deployed application', async () => {
		const response = await fetch(ctx.harper.httpURL);
		strictEqual(response.status, 200);
		const body = await response.text();
		ok(body.includes('<h1>Hello, Harper!</h1>'));
	});
});
