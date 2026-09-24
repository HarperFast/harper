/**
 * A component's root-config entry is an effect of its activation (#2315 step 3): a deploy that fails
 * publishes nothing, a payload deploy takes back the package it replaced, and an activation a crash
 * interrupted between its two renames has its entry published by boot recovery — before
 * `installApplications()` reads the config it installs from.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';

import {
	startHarper,
	killHarper,
	teardownHarper,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { authHeader, operation } from './redeploy-restart-flag-helpers.ts';

const PREFIX = 'root-config-effect';

async function rawOperation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function writeFixture(dir: string, project: string, version: number): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'package.json'), JSON.stringify({ name: project, version: `${version}.0.0` }));
	await writeFile(join(dir, 'version.txt'), String(version));
	await writeFile(join(dir, 'config.yaml'), 'rest: true\n');
}

async function buildPayload(project: string, version: number): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${PREFIX}-fixture-`));
	try {
		await writeFixture(dir, project, version);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function componentsRoot(ctx: ContextWithHarper): string {
	return join(ctx.harper.dataRootDir, 'components');
}

async function rootConfigEntry(ctx: ContextWithHarper, project: string): Promise<any> {
	return parse(await readFile(join(ctx.harper.dataRootDir, 'harper-config.yaml'), 'utf8'))?.[project];
}

async function liveVersion(ctx: ContextWithHarper, project: string): Promise<string> {
	return readFile(join(componentsRoot(ctx), project, 'version.txt'), 'utf8');
}

suite('deploy_component publishes root config as an effect of the activation', (ctx: ContextWithHarper) => {
	let fixturesDir: string;
	// A package the registry is not involved in: a tarball on disk, which every node and every boot
	// resolves to the same bytes.
	let packagedV2: string;

	before(async () => {
		fixturesDir = await mkdtemp(join(tmpdir(), `${PREFIX}-packages-`));
		packagedV2 = join(fixturesDir, 'app-v2.tgz');
		await writeFile(packagedV2, Buffer.from(await buildPayload(`${PREFIX}-package`, 2), 'base64'));
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(fixturesDir, { recursive: true, force: true });
	});

	test('a package deploy whose build fails leaves no entry naming it', async () => {
		const project = `${PREFIX}-failed`;
		const response = await rawOperation(ctx, {
			operation: 'deploy_component',
			project,
			package: join(fixturesDir, 'does-not-exist.tgz'),
			restart: false,
		});

		ok(response.status >= 400, `the build fails: ${JSON.stringify(response.body)}`);
		strictEqual(
			await rootConfigEntry(ctx, project),
			undefined,
			'nothing names a release that never went live, so the next boot has nothing to install'
		);
	});

	test('a package deploy publishes its entry once the release is live', async () => {
		const project = `${PREFIX}-package`;
		await operation(ctx, { operation: 'deploy_component', project, package: packagedV2, restart: false });

		strictEqual(await liveVersion(ctx, project), '2');
		deepStrictEqual(await rootConfigEntry(ctx, project), { package: packagedV2 });
	});

	test('a payload redeploy takes back the package it replaced', async () => {
		const project = `${PREFIX}-package`;
		await operation(ctx, {
			operation: 'deploy_component',
			project,
			payload: await buildPayload(project, 3),
			restart: false,
		});

		strictEqual(await liveVersion(ctx, project), '3');
		strictEqual(
			await rootConfigEntry(ctx, project),
			undefined,
			'a cold install would otherwise resolve the old package over the payload release that is live'
		);
	});

	test('a stage publishes nothing, and its activation publishes the entry the build recorded', async () => {
		const project = `${PREFIX}-staged`;
		const staged = await operation(ctx, {
			operation: 'deploy_component',
			project,
			package: packagedV2,
			activate: false,
		});
		strictEqual(await rootConfigEntry(ctx, project), undefined, 'nothing is live, so nothing is published');

		await operation(ctx, { operation: 'deploy_component', project, deployment_id: staged.deployment_id });

		strictEqual(await liveVersion(ctx, project), '2');
		deepStrictEqual(await rootConfigEntry(ctx, project), { package: packagedV2 });
	});

	test('drop_component removes the entry through the same writer', async () => {
		const project = `${PREFIX}-staged`;
		await operation(ctx, { operation: 'drop_component', project });

		strictEqual(await rootConfigEntry(ctx, project), undefined);
	});

	test('boot recovery publishes the entry of an activation a crash interrupted between its two renames', async () => {
		const project = `${PREFIX}-crashed`;
		await operation(ctx, {
			operation: 'deploy_component',
			project,
			payload: await buildPayload(project, 1),
			restart: false,
		});
		await killHarper(ctx);

		// What a staged activation of a package artifact leaves when the process dies after moving the live
		// tree aside and before renaming the candidate in. The journal is the version a build before this change
		// wrote, whose effect only the artifact descriptor records — the upgrade case, and the window in which
		// that build's entry was never published.
		const root = componentsRoot(ctx);
		const deploymentId = randomUUID();
		const deploymentDir = join(root, '.deploy-staging', deploymentId);
		await writeFixture(join(deploymentDir, project), project, 2);
		await writeFile(join(deploymentDir, '.component'), project);
		await writeFile(
			join(deploymentDir, '.artifact.json'),
			JSON.stringify({
				v: 1,
				component: project,
				rootConfig: { package: packagedV2 },
				installationIsOpaque: false,
				isolated: false,
			})
		);
		await writeFile(join(deploymentDir, '.complete'), '');
		await writeFile(
			join(deploymentDir, '.activation.json'),
			JSON.stringify({ v: 1, component: project, candidateId: deploymentId })
		);
		const asideDir = join(root, '.deploy-aside', project);
		await mkdir(asideDir, { recursive: true });
		await rename(join(root, project), join(asideDir, `.in-progress-${Date.now()}-1-${randomUUID()}`));
		strictEqual(await rootConfigEntry(ctx, project), undefined, 'the entry was never published before the crash');

		await startHarper(ctx, { config: {}, env: {} });

		// Not proof of WHICH copy is live: installApplications() then reinstalls the package over the rolled-forward
		// tree, since no deploy writes harper-application-lock.json, and both are version 2 here. What this case
		// pins is the order — the entry is on disk and refreshed before that install reads it.
		strictEqual(await liveVersion(ctx, project), '2', 'the release the interrupted activation carried is live');
		deepStrictEqual(await rootConfigEntry(ctx, project), { package: packagedV2 }, 'recovery published its entry');
		const lock = JSON.parse(await readFile(join(ctx.harper.dataRootDir, 'harper-application-lock.json'), 'utf8'));
		deepStrictEqual(
			lock.applications?.[project],
			{ package: packagedV2 },
			'which installApplications() on the main thread read in the same boot, after recovery refreshed it'
		);
	});
});
