/**
 * `deploy_component` keeps the previous version in place for the whole duration of the replacement's
 * install, and only publishes the replacement once it is completely built (#2315 step 1).
 *
 * The regression this guards: `prepareApplication` used to rename the LIVE component directory aside
 * *before* extracting, then run `npm install` in the now-empty live path. For a git-reference package or
 * a large dependency tree that leaves the component broken for minutes — the directory a request resolves
 * against holds a partially-built tree, or nothing at all.
 *
 * The install here blocks on a release file, which is what makes the window observable at all: without it
 * the install finishes too fast to sample. While it is blocked we sample the live directory repeatedly and
 * require every sample to be the *previous* release, byte for byte. Against the pre-fix code the very
 * first sample fails, because the directory has already been moved into `.deploy-aside`.
 *
 * Scope, stated precisely because it is easy to overclaim: this samples the component directory ON DISK
 * through the real operations API. It does NOT prove request-level availability — no route is exercised —
 * and it does not prove the config ordering for a rejected deploy, since both deploys here succeed. What it
 * does additionally cover is that a payload deploy strips a stale `package` entry, which is the cold-install
 * hazard. Request-path and rejected-deploy config coverage live in the unit suites.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
import { operation } from './redeploy-restart-flag-helpers.ts';

const PROJECT = 'stage-swap-availability';

/**
 * A component carrying a readable version marker. When `blockOn` is given it also carries an install
 * script that parks until that file appears, so the test can hold the deploy open mid-install.
 */
async function buildPayload(version: number, blockOn?: { started: string; release: string }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'stage-swap-fixture-'));
	try {
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PROJECT, version: `${version}.0.0` }));
		await writeFile(join(dir, 'version.txt'), String(version));
		await writeFile(join(dir, 'config.yaml'), 'rest: true\n');
		if (blockOn) {
			await writeFile(
				join(dir, 'install.js'),
				`const fs = require('node:fs');\n` +
					`fs.writeFileSync(${JSON.stringify(blockOn.started)}, 'started');\n` +
					`const deadline = Date.now() + 60000;\n` +
					`(function wait() {\n` +
					`\tif (fs.existsSync(${JSON.stringify(blockOn.release)})) process.exit(0);\n` +
					`\tif (Date.now() >= deadline) process.exit(2);\n` +
					`\tsetTimeout(wait, 10);\n` +
					`})();\n`
			);
		}
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

suite('deploy_component keeps the previous version in place while the replacement builds', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the live component directory is never disturbed until the candidate is complete', async () => {
		const componentsRoot = join(ctx.harper.dataRootDir, 'components');
		const livePath = join(componentsRoot, PROJECT);
		const versionFile = join(livePath, 'version.txt');
		const scratch = await mkdtemp(join(tmpdir(), 'stage-swap-signals-'));
		const started = join(scratch, 'install-started');
		const release = join(scratch, 'install-release');

		try {
			await operation(ctx, {
				operation: 'deploy_component',
				project: PROJECT,
				payload: await buildPayload(1),
				restart: false,
			});
			strictEqual(await readFile(versionFile, 'utf8'), '1', 'the first release is live');

			// Held open by the install script, so the window is long enough to sample deterministically.
			const redeploy = operation(ctx, {
				operation: 'deploy_component',
				project: PROJECT,
				payload: await buildPayload(2, { started, release }),
				install_command: 'node install.js',
				install_timeout: 60000,
				restart: false,
			});

			const deadline = Date.now() + 30000;
			while (!existsSync(started)) {
				if (Date.now() >= deadline) throw new Error('the blocked install never started');
				await sleep(20);
			}

			// The install is now parked. Every observation of the live path must still be release 1.
			const samples: string[] = [];
			for (let i = 0; i < 25; i++) {
				samples.push(await readFile(versionFile, 'utf8').catch((error) => `UNREADABLE: ${error.code}`));
				await sleep(20);
			}
			ok(
				samples.every((sample) => sample === '1'),
				`the previous release must stay in place for the whole install; saw ${JSON.stringify([...new Set(samples)])}`
			);

			await writeFile(release, 'go');
			await redeploy;

			strictEqual(await readFile(versionFile, 'utf8'), '2', 'the replacement is live once it is complete');
			// A payload deploy must not leave a `package` entry a cold install would resolve instead.
			const config = await readFile(join(ctx.harper.dataRootDir, 'harperdb-config.yaml'), 'utf8').catch(() => '');
			ok(!/^\s*package:/m.test(config.split(PROJECT)[1] ?? ''), 'no stale package entry survives a payload deploy');
			// Nothing left behind: no candidate, and no displaced tree accumulating per deploy.
			const staged = await readdir(join(componentsRoot, '.deploy-staging')).catch(() => []);
			strictEqual(staged.length, 0, `staging should be empty, found ${JSON.stringify(staged)}`);
			ok(!existsSync(join(componentsRoot, '.deploy-aside', PROJECT)), 'the displaced version is swept');
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});
});
