/**
 * Staging a release and activating it later, over real HTTP and across a full Harper process restart
 * (#2315 step 6) — the restart is the point, since the promise is that an operator can build now and cut
 * over later without the component rebuilding or resolving anything in between. And going back (step 5): the
 * release an activation displaces is kept under the deployment id that built it, so that id puts it back.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
	startHarper,
	killHarper,
	teardownHarper,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { authHeader, operation } from './redeploy-restart-flag-helpers.ts';
import { inventoryBuild } from '../../dist/components/buildArtifact.js';

const PROJECT = 'stage-then-activate';

// `node` is in the default `applications.allowedSpawnCommands`. The command appends one line per run to
// the build directory it runs in, so the line count IS the number of installs this artifact has had.
const INSTALL_COUNTER_COMMAND = `node -e "require('node:fs').appendFileSync('install-count.txt','ran\\n')"`;

async function rawOperation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

const VERSION_RESOURCE = 'StageThenActivateVersion';

/** Every release of PROJECT also serves its version, so a test can see which one the workers are running. */
async function buildPayload(project: string, version: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'stage-then-activate-fixture-'));
	try {
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({ name: project, version: `${version}.0.0`, type: 'module' })
		);
		await writeFile(join(dir, 'version.txt'), String(version));
		if (project === PROJECT) {
			await writeFile(join(dir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
			await writeFile(
				join(dir, 'resources.js'),
				`export class ${VERSION_RESOURCE} extends Resource {\n` +
					'\tstatic loadAsInstance = false;\n' +
					`\tget() { return { version: ${version} }; }\n` +
					'}\n'
			);
		} else {
			await writeFile(join(dir, 'config.yaml'), 'rest: true\n');
		}
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function servedVersion(ctx: ContextWithHarper): Promise<number | undefined> {
	try {
		const response = await fetch(`${ctx.harper.httpURL}/${VERSION_RESOURCE}`, {
			headers: { Authorization: authHeader(ctx) },
		});
		if (response.status !== 200) {
			await response.body?.cancel();
			return;
		}
		return ((await response.json()) as { version?: number } | null)?.version;
	} catch {
		return;
	}
}

async function waitForServedVersion(ctx: ContextWithHarper, version: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	let seen: number | undefined;
	while (Date.now() < deadline) {
		seen = await servedVersion(ctx);
		if (seen === version) return;
		await sleep(250);
	}
	throw new Error(`Timed out waiting for version ${version} to be served; last saw ${seen}`);
}

function componentsRoot(ctx: ContextWithHarper): string {
	return join(ctx.harper.dataRootDir, 'components');
}

function stagingDir(ctx: ContextWithHarper, deploymentId: string): string {
	return join(componentsRoot(ctx), '.deploy-staging', deploymentId);
}

suite('deploy_component stages a build and activates it later by deployment id', (ctx: ContextWithHarper) => {
	let firstId: string;
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
		firstId = response.deployment_id;
		strictEqual(await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'), '1');
	});

	test('activate: false builds and certifies without changing what is serving', async () => {
		const response = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(PROJECT, 2),
			activate: false,
			// Counts its own runs into the build directory. The activation later asserts the count is still 1,
			// which is what proves the install did not run again — the tree being identical would not, since a
			// rebuild from the same payload produces the same bytes.
			install_command: INSTALL_COUNTER_COMMAND,
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
		// The tarball was reclaimed above, so the artifact on disk is all an activation has to work from.
		const { build } = JSON.parse(await readFile(join(stagingDir(ctx, stagedId), '.artifact.json'), 'utf8'));

		await killHarper(ctx);
		await startHarper(ctx, { config: {}, env: {} });

		ok(existsSync(stagingDir(ctx, stagedId)), 'boot recovery keeps a dormant artifact rather than reclaiming it');

		const response = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: stagedId,
			restart: true,
		});

		match(String(response.message), /Successfully deployed/);
		strictEqual(await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'), '2', 'version 2 is live');
		await waitForServedVersion(ctx, 2);
		strictEqual(
			(await inventoryBuild(join(componentsRoot(ctx), PROJECT))).tree,
			build.tree,
			'the live tree IS the certified tree, not a fresh extract of the payload'
		);
		strictEqual(
			(await readFile(join(componentsRoot(ctx), PROJECT, 'install-count.txt'), 'utf8')).trim(),
			'ran',
			'and its install ran exactly once, at staging time — the activation installed nothing'
		);
		strictEqual(existsSync(join(stagingDir(ctx, stagedId), PROJECT)), false, 'and the rename consumed the tree');
	});

	test('activating the release that is already live succeeds without a swap', async () => {
		// A retry of an activation that swapped here and then failed elsewhere: answering it is what lets the retry
		// go on to reach the nodes that still hold the artifact.
		const live = join(componentsRoot(ctx), PROJECT);
		const before = (await inventoryBuild(live)).tree;
		const again = await rawOperation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: stagedId,
		});
		strictEqual(again.status, 200, JSON.stringify(again.body));
		strictEqual((await inventoryBuild(live)).tree, before, 'the live tree is still the one it was: nothing swapped');
	});

	test('activating an id nothing on this node answers to is refused as not found', async () => {
		const unknown = await rawOperation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: randomUUID(),
		});
		strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
		match(JSON.stringify(unknown.body), /no staged build with that id/);
		strictEqual(
			await readFile(join(componentsRoot(ctx), PROJECT, 'version.txt'), 'utf8'),
			'2',
			'and a refused activation changes nothing'
		);
	});

	test('the release an activation displaced is kept under its own id, and activating that id serves it again', async () => {
		ok(existsSync(join(stagingDir(ctx, firstId), PROJECT)), 'version 1 waits under the deployment that built it');

		const reverted = await operation(ctx, {
			operation: 'deploy_component',
			project: PROJECT,
			deployment_id: firstId,
			restart: true,
		});

		match(String(reverted.message), /Successfully deployed/);
		await waitForServedVersion(ctx, 1);
		ok(existsSync(join(stagingDir(ctx, stagedId), PROJECT)), 'and version 2 now waits under its own id');

		await killHarper(ctx);
		await startHarper(ctx, { config: {}, env: {} });

		await waitForServedVersion(ctx, 1);
		ok(existsSync(join(stagingDir(ctx, stagedId), PROJECT)), 'which a restart keeps, rather than reclaiming it');
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
