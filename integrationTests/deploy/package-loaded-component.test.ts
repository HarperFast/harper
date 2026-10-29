/**
 * `package_component` on a component a worker has LOADED — harper#2487, harper#3207, harper#2577.
 *
 * Pins: `symlinkHarperModule` links the running install into `<component>/node_modules/harper` on every
 * non-root component load, and the packer dereferences symlinks and recurses into linked directories. So
 * packaging a component that has actually been loaded used to walk the entire Harper install: observed as
 * ~46s of tarring followed by `Maximum response size reached`. A sub-component the application loads from its
 * own `node_modules` (a config.yaml `package:` entry) gets the same link one level down, which the packer
 * followed once per such sub-component until harper#3207.
 *
 * A legacy component's `node_modules/harperdb` is re-linked the same way but only when the path already exists, and
 * `installApplication` skips installing when `node_modules` does, so the packer ships an empty directory there
 * (harper#2577) and the test redeploys the archive to show the loader turns it back into the link.
 *
 * The unit test in `unitTests/components/packageComponent.test.js` plants the link directly; this one earns
 * it the way production does — deploy with `restart: true` so a serving worker loads the component — which
 * is the half a packer-only test cannot show.
 *
 * Run: npm run test:integration -- "integrationTests/deploy/package-loaded-component.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir, readFile, lstat, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { setTimeout as sleep } from 'node:timers/promises';
import tar from 'tar-fs';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'pkg-loaded-probe';
const PLUGIN = 'pkg-loaded-plugin';

// Skipped on Windows for the same reason as the sibling `deploy-dangling-symlink` suite: `restart: true`
// restarts there consistently miss even a 45s readiness deadline (harper#1813 — `canPreStartReplacement` is
// false for win32, so there is no overlapping replacement). This test additionally depends on
// `symlinkHarperModule` succeeding, and on Windows that needs developer mode for symlinks — its EPERM is
// caught and logged by the loader, so the link would simply be absent and this suite would report the
// packer broken when it is fine.
const skipSuite = process.platform === 'win32';

async function operation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': auth },
		body: JSON.stringify(body),
	});
	strictEqual(response.status, 200, `${body.operation} failed with ${response.status}`);
	return response.json();
}

/** A real `harperdb` at the root and under the sub-component: the loader turns an existing one into the install link. */
async function seedLegacyHarperdb(dir: string): Promise<void> {
	for (const base of [dir, join(dir, 'node_modules', PLUGIN)]) {
		const legacy = join(base, 'node_modules', 'harperdb');
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, 'package.json'), JSON.stringify({ name: 'harperdb', version: '4.0.0' }));
	}
}

async function linksToInstall(path: string, siblingInstallLink: string): Promise<boolean> {
	try {
		return (await lstat(path)).isSymbolicLink() && (await realpath(path)) === (await realpath(siblingInstallLink));
	} catch {
		return false;
	}
}

async function waitForRoute(ctx: ContextWithHarper, route: string, accept: (status: number) => boolean): Promise<void> {
	const deadline = Date.now() + 45_000;
	while (true) {
		try {
			if (accept((await fetch(`${ctx.harper.httpURL}${route}`)).status)) return;
		} catch {
			// not accepting connections yet
		}
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${route} after restart`);
		await sleep(250);
	}
}

async function waitFor(what: string, condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await sleep(100);
	}
}

/** A component with a loadable resource, so a worker actually loads it and plants the links. */
async function buildPayload(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'pkg-loaded-fixture-'));
	try {
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
		await writeFile(
			join(dir, 'config.yaml'),
			`rest: true\njsResource:\n  files: resource.js\n${PLUGIN}:\n  package: ${PLUGIN}\n`
		);
		await writeFile(
			join(dir, 'resource.js'),
			'export class PkgLoadedProbe extends Resource {\n\tget() {\n\t\treturn { ok: true };\n\t}\n}\n'
		);
		await mkdir(join(dir, 'web'), { recursive: true });
		await writeFile(join(dir, 'web', 'index.html'), '<!doctype html><title>probe</title>\n');
		const pluginDir = join(dir, 'node_modules', PLUGIN);
		await mkdir(pluginDir, { recursive: true });
		await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0' }));
		await writeFile(join(pluginDir, 'config.yaml'), 'jsResource:\n  files: plugin.js\n');
		await writeFile(
			join(pluginDir, 'plugin.js'),
			'export class PkgLoadedPlugin extends Resource {\n\tget() {\n\t\treturn { ok: true };\n\t}\n}\n'
		);
		await seedLegacyHarperdb(dir);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Deploys the fixture and returns its live path once a worker has loaded it and planted every link under test. */
async function deployLoaded(ctx: ContextWithHarper): Promise<string> {
	// `restart: true` is the whole point: it makes a serving worker load the component, which is what
	// creates the link. Without the restart nothing has loaded it and the bug is unreachable.
	await operation(ctx, {
		operation: 'deploy_component',
		project: PROJECT,
		payload: await buildPayload(),
		restart: true,
	});

	// `deploy_component` returns before the replacement worker has finished loading, so the link this
	// test depends on may not exist yet. Wait for the component's own route to answer — that is the
	// signal a worker completed the load that plants it.
	await waitForRoute(ctx, '/PkgLoadedProbe/', (status) => status < 500);

	const livePath = join(ctx.harper.dataRootDir, 'components', PROJECT);
	ok(existsSync(join(livePath, 'resource.js')), 'the component is live');
	// The link is expected to be here — the tests are about the packer not following it, not about
	// preventing it. If a future change stops creating it, they stop proving anything, so assert
	// its presence rather than silently passing.
	const installLink = join(livePath, 'node_modules', 'harper');
	ok(existsSync(installLink), 'a worker load planted the harper link');
	// The route can answer before the loader reaches the sub-component's entry, so wait for its links as well.
	await waitFor('the sub-component harper link', async () =>
		existsSync(join(livePath, 'node_modules', PLUGIN, 'node_modules', 'harper'))
	);
	for (const base of [livePath, join(livePath, 'node_modules', PLUGIN)]) {
		const legacy = join(base, 'node_modules', 'harperdb');
		await waitFor(`${legacy} to be linked`, () => linksToInstall(legacy, installLink));
	}
	return livePath;
}

suite(
	'package_component does not follow a loaded component into the install',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await startHarper(ctx);
		});
		after(async () => {
			await teardownHarper(ctx);
		});

		test('a component a worker has loaded packages as itself, not as Harper', async () => {
			const livePath = await deployLoaded(ctx);

			const estimate = await operation(ctx, { operation: 'package_component', project: PROJECT, estimate: true });
			ok(
				estimate.total_size < 1_000_000,
				`packaging walked the install (${estimate.total_size} bytes for a handful of small files)`
			);

			// And the real thing, not just the estimate: the payload comes back rather than failing on size.
			const packaged = await operation(ctx, { operation: 'package_component', project: PROJECT });
			ok(typeof packaged.payload === 'string' && packaged.payload.length > 0, 'a payload was produced');
			ok(packaged.payload.length < 2_000_000, `payload carries the install (${packaged.payload.length} base64 chars)`);

			const extractDir = await mkdtemp(join(tmpdir(), 'pkg-loaded-extract-'));
			try {
				await pipeline(Readable.from(Buffer.from(packaged.payload, 'base64')), createGunzip(), tar.extract(extractDir));
				const extractedPlugin = join(extractDir, 'node_modules', PLUGIN);
				strictEqual(
					await readFile(join(extractedPlugin, 'plugin.js'), 'utf8'),
					await readFile(join(livePath, 'node_modules', PLUGIN, 'plugin.js'), 'utf8'),
					'the sub-component ships'
				);
				ok(!existsSync(join(extractedPlugin, 'node_modules', 'harper')), 'the sub-component shipped the install');
				// Present but empty: the loader only relinks a harperdb that exists.
				for (const base of [extractDir, extractedPlugin]) {
					const legacy = join(base, 'node_modules', 'harperdb');
					ok((await lstat(legacy)).isDirectory(), `${legacy} must ship as a directory, not a link`);
					deepStrictEqual(await readdir(legacy), [], `${legacy} shipped content`);
				}
			} finally {
				await rm(extractDir, { recursive: true, force: true });
			}
		});

		test('deploying that package to a fresh component relinks the legacy harperdb', async () => {
			const livePath = await deployLoaded(ctx);
			const { payload } = await operation(ctx, { operation: 'package_component', project: PROJECT });

			await operation(ctx, { operation: 'drop_component', project: PROJECT, restart: true });
			ok(!existsSync(livePath), 'the component was dropped');
			await operation(ctx, { operation: 'deploy_component', project: PROJECT, payload, restart: true });

			// The filesystem, not an `import 'harperdb'`: a VM-loaded import resolves through an alias either way.
			await waitForRoute(ctx, '/PkgLoadedProbe/', (status) => status === 200);
			await waitForRoute(ctx, '/PkgLoadedPlugin/', (status) => status === 200);
			const installLink = join(livePath, 'node_modules', 'harper');
			for (const base of [livePath, join(livePath, 'node_modules', PLUGIN)]) {
				const legacy = join(base, 'node_modules', 'harperdb');
				await waitFor(`${legacy} to be relinked`, () => linksToInstall(legacy, installLink));
			}
		});
	}
);
