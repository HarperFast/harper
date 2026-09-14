/**
 * `deploy_component` can build and certify a release without making it live (`activate: false`), and a
 * later request can make that exact artifact live by deployment id (#2315 step 6).
 *
 * This is the end-to-end route for the step: real HTTP, a real Harper process, and a full process restart
 * between the stage and the activation — because the promise being made is that an operator can build now
 * and cut over later, across a restart, without the component ever rebuilding or resolving anything.
 *
 * It is also the first test in the tree that PRODUCES a dormant staged build rather than planting one;
 * `staging-retention.test.ts` had to plant them because nothing on `main` staged without activating.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
	startHarper,
	killHarper,
	teardownHarper,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { authHeader, operation } from './redeploy-restart-flag-helpers.ts';

const PROJECT = 'stage-then-activate';

/** Raw request, for the cases whose whole point is a non-2xx answer. */
async function rawOperation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function buildPayload(project: string, version: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'stage-then-activate-fixture-'));
	try {
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: project, version: `${version}.0.0` }));
		await writeFile(join(dir, 'version.txt'), String(version));
		await writeFile(join(dir, 'config.yaml'), 'rest: true\n');
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function componentsRoot(ctx: ContextWithHarper): string {
	return join(ctx.harper.dataRootDir, 'components');
}

function stagingDir(ctx: ContextWithHarper, deploymentId: string): string {
	return join(componentsRoot(ctx), '.deploy-staging', deploymentId);
}

suite('deploy_component stages a build and activates it later by deployment id', (ctx: ContextWithHarper) => {
	let stagedId: string;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a normal deploy goes live and hands back its deployment id', async () => {
		const response = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(PROJECT, 1),
			restart: false,
		});

		match(String(response.deployment_id ?? ''), /^[0-9a-f-]{36}$/, 'every deploy returns the id it recorded');
		strictEqual(await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'), '1');
	});

	test('activate: false builds and certifies without changing what is serving', async () => {
		const response = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(PROJECT, 2),
			activate: false,
		});

		stagedId = response.deployment_id;
		ok(stagedId, 'the stage names the artifact it left behind');
		match(String(response.message), /Staged/);

		strictEqual(
			await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'),
			'1',
			'the live tree is untouched by a stage'
		);
		const staged = stagingDir(ctx, stagedId);
		strictEqual(await readFile(join(staged, PROJECT, 'version.txt'), 'utf8'), '2', 'and version 2 is waiting');
		ok(existsSync(join(staged, '.complete')), 'certified');
		ok(existsSync(join(staged, '.artifact.json')), 'and describing what its build decided');
		strictEqual(existsSync(join(staged, '.activation.json')), false, 'with no activation in flight');
	});

	test('the deployment row reports it as staged, and is terminal', async () => {
		const row = await operation(ctx, { operation: 'get_deployment', deployment_id: stagedId });
		strictEqual(row.status, 'staged');

		// Terminal, so the tarball can be reclaimed: the bytes that matter are already on disk.
		const reclaim = await rawOperation(ctx, { operation: 'delete_deployment_payload', deployment_id: stagedId });
		strictEqual(reclaim.status, 200, 'a staged deployment is terminal, not "still in use"');
	});

	test('the artifact survives a full restart and activates without rebuilding', async () => {
		// A marker the packaged tarball does not contain: if activation rebuilt from the payload instead of
		// renaming the certified tree, this file could not be in the live directory afterwards. It also
		// survives the reclaim above, which is the point — the artifact no longer depends on the tarball.
		await writeFile(join(stagingDir(ctx, stagedId), PROJECT, 'not-rebuilt.txt'), 'certified once');

		await killHarper(ctx);
		await startHarper(ctx, { config: {}, env: {} });

		ok(existsSync(stagingDir(ctx, stagedId)), 'boot recovery keeps a dormant artifact rather than reclaiming it');

		const response = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: stagedId,
		});

		match(String(response.message), /Successfully deployed/);
		strictEqual(await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'), '2', 'version 2 is live');
		strictEqual(
			await readFile(join(componentsRoot(ctx), PROJECT, 'not-rebuilt.txt'), 'utf8'),
			'certified once',
			'the live tree IS the certified tree — nothing was resolved, fetched or installed'
		);
		strictEqual(existsSync(stagingDir(ctx, stagedId)), false, 'and the rename consumed the artifact');
	});

	test('activating a consumed or unknown id is refused, and says so', async () => {
		const again = await rawOperation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: stagedId,
		});
		ok(again.status >= 400, 'an artifact is activated once; the rename consumed it');
		match(JSON.stringify(again.body), /no staged build with that id/);

		strictEqual(
			await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'),
			'2',
			'and a refused activation changes nothing'
		);
	});

	test('activating an artifact belonging to another component is refused, and preserves it', async () => {
		const other = `${PROJECT}-other`;
		const staged = await operation(ctx, {
			operation: 'deploy_component',
			project: other,
			payload: await buildPayload(other, 9),
			activate: false,
		});

		const crossed = await rawOperation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: staged.deployment_id,
		});

		ok(crossed.status >= 400);
		match(JSON.stringify(crossed.body), new RegExp(`belongs to '${other}'`));
		ok(
			existsSync(stagingDir(ctx, staged.deployment_id)),
			"another component's artifact is not this request's to remove"
		);
		deepStrictEqual(
			(await readdir(join(componentsRoot(ctx)))).includes(other),
			false,
			'and the component that was only staged is still not live'
		);
	});

	test('a stage cannot ask for a restart, because nothing goes live', async () => {
		const refused = await rawOperation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(PROJECT, 3),
			activate: false,
			restart: true,
		});

		ok(refused.status >= 400);
		match(JSON.stringify(refused.body), /restart/);
	});
});
