/**
 * Canary rollout certification over real HTTP, on one node (harper#2315 step 2). A deploy that restarts workers boots
 * one worker on its release first and holds it out of traffic until it reports whether the release loaded; only then
 * does the rollout go on. A rejection puts back the release it replaced and fails the deploy, and a process that dies
 * before the canary decides comes back on that previous release.
 *
 * Run: npm run test:integration -- "integrationTests/deploy/canary-rollout.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import {
	startHarper,
	killHarper,
	teardownHarper,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { authHeader, operation } from './redeploy-restart-flag-helpers.ts';

const PROJECT = 'canary-web';
const HARPER_CONFIG = { threads: { count: 2 } };

// Worker restarts on Windows routinely outlast the readiness deadlines below (harper#1813).
const skipSuite = process.platform === 'win32';

type Release = { version: number; loadDelayMs?: number; throwAtLoad?: boolean };

function resourceName(project: string): string {
	return project.replace(/(^|-)(\w)/g, (_match, _dash, letter: string) => letter.toUpperCase());
}

/** Writes a release of `project`: `/<Resource>` serves its version, `/<Resource>Lazy` imports `lazy.js` on demand. */
async function writeRelease(dir: string, project: string, { version, loadDelayMs = 0, throwAtLoad = false }: Release) {
	const name = resourceName(project);
	await writeFile(
		join(dir, 'package.json'),
		JSON.stringify({ name: project, version: `${version}.0.0`, type: 'module' })
	);
	await writeFile(join(dir, 'version.txt'), String(version));
	await writeFile(join(dir, 'config.yaml'), 'jsResource:\n  files: resources.js\nrest: true\n');
	await writeFile(join(dir, 'lazy.js'), `export const version = ${version};\n`);
	await writeFile(
		join(dir, 'resources.js'),
		// Blocking, since a resource module has no top-level await: the canary's own thread is all it holds up.
		(loadDelayMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${loadDelayMs});\n` : '') +
			(throwAtLoad ? "throw new Error('canary probe: broken at load');\n" : '') +
			`export class ${name} extends Resource {\n` +
			'\tstatic loadAsInstance = false;\n' +
			`\tget() { return { version: ${version} }; }\n` +
			'}\n' +
			`export class ${name}Lazy extends Resource {\n` +
			'\tstatic loadAsInstance = false;\n' +
			`\tasync get() { return { version: ${version}, lazy: (await import('./lazy.js')).version }; }\n` +
			'}\n'
	);
}

async function buildPayload(project: string, release: Release): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'canary-rollout-fixture-'));
	try {
		await writeRelease(dir, project, release);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function rawOperation(
	ctx: ContextWithHarper,
	body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json().catch(() => undefined) };
}

function deploy(ctx: ContextWithHarper, project: string, release: Release, restart: true | 'rolling' = true) {
	return buildPayload(project, release).then((payload) =>
		rawOperation(ctx, { operation: 'deploy_component', project, payload, restart })
	);
}

/** What `/<path>` answers: its body when 200, otherwise the status, or `undefined` when nothing answered. */
async function answer(ctx: ContextWithHarper, path: string): Promise<any> {
	try {
		const response = await fetch(`${ctx.harper.httpURL}/${path}`, { headers: { Authorization: authHeader(ctx) } });
		if (response.status !== 200) {
			await response.body?.cancel();
			return response.status;
		}
		return await response.json();
	} catch {
		return undefined;
	}
}

async function servedVersion(ctx: ContextWithHarper, project: string): Promise<number | undefined> {
	return (await answer(ctx, resourceName(project)))?.version;
}

async function waitForServedVersion(ctx: ContextWithHarper, project: string, version: number): Promise<void> {
	const deadline = Date.now() + 60_000;
	let seen;
	while (Date.now() < deadline) {
		seen = await servedVersion(ctx, project);
		if (seen === version) return;
		await sleep(250);
	}
	throw new Error(`Timed out waiting for ${project} version ${version}; last saw ${seen}`);
}

/** Samples what `project` serves until `settled` is, so a test can say what answered while a deploy ran. */
async function sampleWhile(ctx: ContextWithHarper, project: string, settled: Promise<unknown>) {
	let done = false;
	void settled.finally(() => (done = true));
	const seen: (number | undefined)[] = [];
	while (!done) {
		seen.push(await servedVersion(ctx, project));
		await sleep(100);
	}
	return seen;
}

function componentsRoot(ctx: ContextWithHarper): string {
	return join(ctx.harper.dataRootDir, 'components');
}

async function liveVersion(ctx: ContextWithHarper, project: string): Promise<string | undefined> {
	return readFile(join(componentsRoot(ctx), project, 'version.txt'), 'utf8').catch(() => undefined);
}

async function waitForLiveVersion(ctx: ContextWithHarper, project: string, version: number) {
	const deadline = Date.now() + 60_000;
	while ((await liveVersion(ctx, project)) !== String(version)) {
		if (Date.now() > deadline) throw new Error(`Release ${version} of ${project} never went live on disk`);
		await sleep(50);
	}
}

/** The releases of `project` holding a certification record: undecided, or refused with nothing to restore. */
async function certificationRecords(ctx: ContextWithHarper, project: string): Promise<string[]> {
	const stagingRoot = join(componentsRoot(ctx), '.deploy-staging');
	const records = [];
	for (const id of await readdir(stagingRoot).catch(() => [] as string[])) {
		const record = await readFile(join(stagingRoot, id, '.certification.json'), 'utf8').catch(() => undefined);
		if (record && JSON.parse(record).component === project) records.push(id);
	}
	return records;
}

async function componentStatusOf(ctx: ContextWithHarper, name: string) {
	const { componentStatus = [] } = await operation(ctx, { operation: 'get_status' });
	return componentStatus.find((entry: { name: string }) => entry.name === name);
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

async function restartHarper(ctx: ContextWithHarper) {
	await killHarper(ctx);
	await startHarper(ctx, { config: HARPER_CONFIG, env: {} });
}

suite(
	'a deploy that restarts workers certifies its release in a canary',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let secondId: string;

		before(async () => {
			await startHarper(ctx, { config: HARPER_CONFIG, env: {} });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a first deploy is certified and goes live', async () => {
			const { status, body } = await deploy(ctx, PROJECT, { version: 1 });
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.certification, 'certified');
			await waitForServedVersion(ctx, PROJECT, 1);
			deepStrictEqual(
				await certificationRecords(ctx, PROJECT),
				[],
				'a certified release keeps no record once rolled out'
			);
		});

		test('the release it replaces keeps serving while the canary loads, and the release rolls out once it has', async () => {
			const deploying = deploy(ctx, PROJECT, { version: 2, loadDelayMs: 5000 });
			await waitForLiveVersion(ctx, PROJECT, 2);
			// Release 2 is live on disk and its canary is loading it: every worker answering is still on release 1.
			const heldWindow = sampleWhile(ctx, PROJECT, sleep(2500));
			const { status, body } = await deploying;
			const whileHeld = await heldWindow;
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.certification, 'certified');
			secondId = body.deployment_id;
			ok(whileHeld.length > 5, `sampled ${whileHeld.length} times`);
			deepStrictEqual(
				[...new Set(whileHeld)],
				[1],
				'only the release being replaced answered while its successor was held'
			);
			for (let index = 0; index < 10; index++) {
				strictEqual(await servedVersion(ctx, PROJECT), 2, 'the deploy answers once every worker serves the release');
			}
		});

		test('a release that throws at load is rejected, the release it replaced is put back, and it never serves', async () => {
			const deploying = deploy(ctx, PROJECT, { version: 3, throwAtLoad: true });
			const seen = await sampleWhile(ctx, PROJECT, deploying);
			const { status, body } = await deploying;
			strictEqual(status, 400, JSON.stringify(body));
			match(body.error, /release .* failed to load in its canary worker: .*canary probe: broken at load/);
			match(body.error, new RegExp(`Deployment ${secondId}, the release it replaced, is live again`));
			strictEqual(body.certification?.status, 'rejected');
			strictEqual(body.certification?.restored, secondId);
			strictEqual(body.certification?.failed_closed, false);
			ok(
				body.certification?.failures?.some((failure: { message: string }) => /broken at load/.test(failure.message)),
				JSON.stringify(body.certification)
			);
			deepStrictEqual([...new Set(seen)], [2], 'the release it replaced answered throughout');
			strictEqual(await liveVersion(ctx, PROJECT), '2', 'and is the live tree again');
			deepStrictEqual(await certificationRecords(ctx, PROJECT), [], 'a restored rejection keeps no record');
		});

		test('a rejected first deploy fails closed, stays refused across a restart, and a fixed deploy replaces it', async () => {
			const project = 'canary-first';
			const rejected = await deploy(ctx, project, { version: 1, throwAtLoad: true });
			strictEqual(rejected.status, 400, JSON.stringify(rejected.body));
			strictEqual(rejected.body.certification?.restored, null);
			strictEqual(rejected.body.certification?.failed_closed, true);
			match(rejected.body.error, /failed closed on this node until it is deployed again/);
			strictEqual(await liveVersion(ctx, project), '1', 'with nothing to put back, the release stays on disk');
			deepStrictEqual(
				await certificationRecords(ctx, project),
				[rejected.body.deployment_id],
				'and its rejection is kept'
			);

			await restartHarper(ctx);
			const status = await componentStatusOf(ctx, project);
			strictEqual(status?.status, 'error', JSON.stringify(status));
			match(
				status.latestMessage,
				/its release .* is not certified to run on this node, .*canary probe: broken at load/
			);
			strictEqual(await answer(ctx, resourceName(project)), 404, 'its resources are not served');
			await waitForServedVersion(ctx, PROJECT, 2);

			const fixed = await deploy(ctx, project, { version: 2 });
			strictEqual(fixed.status, 200, JSON.stringify(fixed.body));
			strictEqual(fixed.body.certification, 'certified');
			await waitForServedVersion(ctx, project, 2);
		});

		test('a process that dies while its canary is held comes back on the release it replaced', async () => {
			const deploying = deploy(ctx, PROJECT, { version: 4, loadDelayMs: 60_000 }).catch((error) => error);
			await waitForLiveVersion(ctx, PROJECT, 4);
			strictEqual(
				(await certificationRecords(ctx, PROJECT)).length,
				1,
				'the release is pending while its canary loads'
			);

			// Abruptly, so nothing decides on the way down: the next boot finds the release live and undecided.
			const exited = once(ctx.harper.process, 'exit');
			process.kill(-ctx.harper.process.pid!, 'SIGKILL');
			await within(exited, 30_000, 'Harper exiting after SIGKILL');
			await deploying;
			await startHarper(ctx, { config: HARPER_CONFIG, env: {} });

			strictEqual(await liveVersion(ctx, PROJECT), '2', 'boot restored the release the undecided one replaced');
			await waitForServedVersion(ctx, PROJECT, 2);
			deepStrictEqual(await certificationRecords(ctx, PROJECT), [], 'and settled its record');
		});

		test('a rolling deploy certifies on this node, and a node without peers activates nowhere else', async () => {
			const { status, body } = await deploy(ctx, PROJECT, { version: 5 }, 'rolling');
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.certification, 'certified');
			match(body.message, /activating it on each other node in turn/);
			ok(body.restartJobId, 'the peers are activated by a job');
			await waitForServedVersion(ctx, PROJECT, 5);

			const deadline = Date.now() + 30_000;
			let job;
			while (Date.now() < deadline) {
				[job] = await operation(ctx, { operation: 'get_job', id: body.restartJobId });
				if (job?.status === 'COMPLETE' || job?.status === 'ERROR') break;
				await sleep(250);
			}
			strictEqual(job?.status, 'COMPLETE', JSON.stringify(job));
		});

		test("a worker the rollout has not reached yet imports lazily from the live tree: the canary certifies only a boot's load", async () => {
			// The boundary of the claim, pinned so a change to it is deliberate: a release goes live on disk before its
			// canary boots, so a module a running worker first imports during the hold comes from the new release.
			// Taking the node out of rotation first is harper#2975.
			const project = 'canary-lazy';
			strictEqual((await deploy(ctx, project, { version: 1 })).status, 200);
			await waitForServedVersion(ctx, project, 1);

			const deploying = deploy(ctx, project, { version: 2, loadDelayMs: 5000 });
			await waitForLiveVersion(ctx, project, 2);
			deepStrictEqual(await answer(ctx, `${resourceName(project)}Lazy`), { version: 1, lazy: 2 });
			strictEqual((await deploying).status, 200);
		});
	}
);

suite('a package deploy that restarts workers', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const project = 'canary-package';
	let packageDir: string;
	let tarballPath: string;

	/** A tarball, which installs as a tree of its own; a `file:` directory installs as a link to its source. */
	async function packageTarball(name: string, release: Release): Promise<string> {
		const sourceRoot = join(packageDir, `${name}-source`);
		await mkdir(join(sourceRoot, 'package'), { recursive: true });
		await writeRelease(join(sourceRoot, 'package'), name, release);
		const tarball = join(packageDir, `${name}-${release.version}.0.0.tgz`);
		await writeFile(tarball, Buffer.from(await targz(sourceRoot), 'base64'));
		return tarball;
	}

	before(async () => {
		packageDir = await mkdtemp(join(tmpdir(), 'canary-package-'));
		tarballPath = await packageTarball(project, { version: 1 });
		await startHarper(ctx, { config: HARPER_CONFIG, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
		await rm(packageDir, { recursive: true, force: true });
	});

	test('is certified, and the next start keeps the tree it certified rather than installing it again', async () => {
		const { status, body } = await rawOperation(ctx, {
			operation: 'deploy_component',
			project,
			package: `file:${tarballPath}`,
			restart: true,
		});
		strictEqual(status, 200, JSON.stringify(body));
		strictEqual(body.certification, 'certified');
		await waitForServedVersion(ctx, project, 1);
		// The restart's root reload used to reinstall the package over the release the deploy had just activated.
		const marker = JSON.parse(await readFile(join(componentsRoot(ctx), project, '.harper-deployment.json'), 'utf8'));
		strictEqual(marker.deploymentId, body.deployment_id, 'the release live is the one deployed');
		// A file no install of the package produces: it survives only if the live tree is not replaced.
		await writeFile(join(componentsRoot(ctx), project, 'certified-tree.txt'), 'kept');

		await restartHarper(ctx);
		await waitForServedVersion(ctx, project, 1);
		strictEqual(
			await readFile(join(componentsRoot(ctx), project, 'certified-tree.txt'), 'utf8').catch(() => undefined),
			'kept',
			'the live tree is the one the canary certified'
		);
	});

	test('a rejected first package deploy fails closed: the next start neither installs nor loads it', async () => {
		const broken = 'canary-package-broken';
		const { status, body } = await rawOperation(ctx, {
			operation: 'deploy_component',
			project: broken,
			package: `file:${await packageTarball(broken, { version: 1, throwAtLoad: true })}`,
			restart: true,
		});
		strictEqual(status, 400, JSON.stringify(body));
		strictEqual(body.certification?.failed_closed, true);
		await writeFile(join(componentsRoot(ctx), broken, 'refused-tree.txt'), 'kept');

		await restartHarper(ctx);
		const refused = await componentStatusOf(ctx, broken);
		strictEqual(refused?.status, 'error', JSON.stringify(refused));
		match(refused.latestMessage, /is not certified to run on this node, .*canary probe: broken at load/);
		strictEqual(await answer(ctx, resourceName(broken)), 404, 'its resources are not served');
		strictEqual(
			await readFile(join(componentsRoot(ctx), broken, 'refused-tree.txt'), 'utf8').catch(() => undefined),
			'kept',
			'and its refused tree was not replaced by a fresh install'
		);
		await waitForServedVersion(ctx, project, 1);
	});
});
