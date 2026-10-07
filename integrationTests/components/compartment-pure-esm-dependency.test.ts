/**
 * A dependency whose package exports carry only an `import` condition loads under
 * `applications.moduleLoader: compartment`, on Node and on Bun, with and without SES lockdown.
 *
 * Run: npm run test:integration -- "integrationTests/components/compartment-pure-esm-dependency.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { authHeader } from '../deploy/redeploy-restart-flag-helpers.ts';

async function writeFixture(parentDirectory: string): Promise<string> {
	const appDirectory = join(parentDirectory, 'compartment-pure-esm-app');
	const dependencyDirectory = join(appDirectory, 'node_modules', 'pure-esm-probe');
	await mkdir(dependencyDirectory, { recursive: true });
	await writeFile(join(appDirectory, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
	await writeFile(
		join(appDirectory, 'package.json'),
		JSON.stringify({ name: 'compartment-pure-esm-app', type: 'module', dependencies: { 'pure-esm-probe': '1.0.0' } })
	);
	await writeFile(
		join(appDirectory, 'resources.js'),
		"import { Resource } from 'harper';\n" +
			"import { VALUE } from 'pure-esm-probe';\n" +
			'const frozenAtLoad = Object.isFrozen(Array.prototype);\n' +
			'export class PureESMProbe extends Resource {\n' +
			'\tstatic loadAsInstance = false;\n' +
			'\tget() { return { value: VALUE, frozenAtLoad }; }\n' +
			'}\n'
	);
	await writeFile(
		join(dependencyDirectory, 'package.json'),
		JSON.stringify({
			name: 'pure-esm-probe',
			version: '1.0.0',
			type: 'module',
			exports: { '.': { import: './index.js' } },
		})
	);
	await writeFile(join(dependencyDirectory, 'index.js'), "export const VALUE = 'loaded-in-compartment';\n");
	return appDirectory;
}

for (const lockdown of ['freeze-after-load', 'ses'] as const) {
	suite(`compartment loader resolves an import-only package (lockdown: ${lockdown})`, (ctx: ContextWithHarper) => {
		let fixtureParent: string;

		before(async () => {
			fixtureParent = await mkdtemp(join(tmpdir(), 'compartment-pure-esm-'));
			await setupHarperWithFixture(ctx, await writeFixture(fixtureParent), {
				config: { applications: { moduleLoader: 'compartment', lockdown } },
			});
		});

		after(async () => {
			await teardownHarper(ctx);
			await rm(fixtureParent, { recursive: true, force: true });
		});

		test('serves a resource that imports the dependency', async () => {
			const deadline = Date.now() + 30_000;
			let status = 0;
			while (Date.now() < deadline) {
				let response: Response;
				try {
					response = await fetch(`${ctx.harper.httpURL}/PureESMProbe`, {
						headers: { Authorization: authHeader(ctx) },
						signal: AbortSignal.timeout(5_000),
					});
				} catch {
					await sleep(250);
					continue;
				}
				status = response.status;
				if (status === 200) {
					const body = (await response.json()) as { value: string; frozenAtLoad: boolean };
					strictEqual(body.value, 'loaded-in-compartment');
					strictEqual(body.frozenAtLoad, lockdown === 'ses');
					return;
				}
				await response.body?.cancel();
				await sleep(250);
			}
			strictEqual(status, 200, 'PureESMProbe never became reachable; the component failed to load');
		});
	});
}
