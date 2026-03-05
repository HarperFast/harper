/**
 * Deploy an application from a GitHub repository.
 *
 * Verifies application is deployed correctly and is accessible via both API and static site.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { setupHarper, teardownHarper, type ContextWithHarper } from '../utils/harperLifecycle.ts';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

suite('GitHub application deployment', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx);
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
		const githubURL = 'https://github.com/HarperFast/application-template';
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'deploy_component',
				project,
				package: githubURL,
				restart: true,
			}),
		});
		strictEqual(response.status, 200);
		const body = await response.json();
		deepStrictEqual(body, { message: 'Successfully deployed: test-application, restarting Harper' });
		// Poll until the application API is ready (restart is async, fixed sleep is flaky)
		const deadline = Date.now() + 30_000;
		while (true) {
			try {
				const check = await fetch(`${ctx.harper.httpURL}/Greeting`);
				if (check.status === 200) break;
			} catch {
				// server not yet accepting connections
			}
			if (Date.now() > deadline) throw new Error('Timed out waiting for application to be ready after restart');
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		ok(existsSync(join(ctx.harper.installDir, 'components', project)));

		// const harperAppLock = await readFile(join(ctx.harper.installDir, 'harper-application-lock.json'), 'utf-8');
		// deepStrictEqual(JSON.parse(harperAppLock), {
		// 	applications: {
		// 		'test-application': {}
		// 	}
		// });

		const harperConfig = await readFile(join(ctx.harper.installDir, 'harper-config.yaml'), 'utf-8');
		const harperConfigObj = parse(harperConfig);
		deepStrictEqual(harperConfigObj[project], { package: githubURL });
	});

	test('access application api', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/Greeting`);
		strictEqual(response.status, 200);
		const body = await response.json();
		deepStrictEqual(body, { greeting: 'Hello, world!' });
	});

	test('access application static site', async () => {
		const response = await fetch(ctx.harper.httpURL);
		strictEqual(response.status, 200);
		const body = await response.text();
		ok(body.includes('<h1>Harper Application Template</h1>'));
	});
});
