/**
 * `deployment.stagingRetention.maxCount` bounds how many complete, unactivated builds survive under
 * `.deploy-staging` per component (#2315 step 4). The bound is enforced at the start of that component's
 * next deploy, under its preparation lock, so this plants dormant builds beside a running instance and
 * deploys once through the real operations API — proving the knob reaches the prune through real config
 * loading, and that the deploy itself is untouched by the pruning.
 *
 * Scope: the build state is planted, not produced — nothing on `main` stages without activating yet.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';
import { operation } from './redeploy-restart-flag-helpers.ts';

const PROJECT = 'staging-retention';

async function buildPayload(version: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'staging-retention-fixture-'));
	try {
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PROJECT, version: `${version}.0.0` }));
		await writeFile(join(dir, 'version.txt'), String(version));
		await writeFile(join(dir, 'config.yaml'), 'rest: true\n');
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** A complete, validated build nobody activated: `.complete`, the sidecar, the tree, and no journal. */
async function plantDormantBuild(componentsRoot: string, id: string, completedAt: number): Promise<void> {
	const deploymentDir = join(componentsRoot, '.deploy-staging', id);
	await mkdir(join(deploymentDir, PROJECT), { recursive: true });
	await writeFile(join(deploymentDir, PROJECT, 'version.txt'), id);
	await writeFile(join(deploymentDir, '.component'), PROJECT);
	await writeFile(join(deploymentDir, '.complete'), '');
	await utimes(join(deploymentDir, '.complete'), completedAt, completedAt);
}

suite(
	'deploy_component bounds dormant staged builds to deployment.stagingRetention.maxCount',
	(ctx: ContextWithHarper) => {
		before(async () => {
			await startHarper(ctx, { config: { deployment: { stagingRetention: { maxCount: 1 } } }, env: {} });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('the next deploy of the component keeps only its newest dormant build', async () => {
			const componentsRoot = join(ctx.harper.dataRootDir, 'components');
			await plantDormantBuild(componentsRoot, 'd-older', 1_000);
			await plantDormantBuild(componentsRoot, 'd-newer', 2_000);
			deepStrictEqual((await readdir(join(componentsRoot, '.deploy-staging'))).sort(), ['d-newer', 'd-older']);

			await operation(ctx, {
				operation: 'deploy_component',
				project: PROJECT,
				payload: await buildPayload(1),
				restart: false,
			});

			strictEqual(await readFile(join(componentsRoot, PROJECT, 'version.txt'), 'utf8'), '1', 'the deploy landed');
			deepStrictEqual(
				await readdir(join(componentsRoot, '.deploy-staging')),
				['d-newer'],
				'the older dormant build was pruned, the newest kept, and the deploy left no candidate of its own'
			);
		});
	}
);
