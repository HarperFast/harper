/**
 * `package_component` on a component a worker has LOADED — harper#2487.
 *
 * Pins: `symlinkHarperModule` links the running install into `<component>/node_modules/harper` on every
 * non-root component load, and the packer dereferences symlinks and recurses into linked directories. So
 * packaging a component that has actually been loaded used to walk the entire Harper install: observed as
 * ~46s of tarring followed by `Maximum response size reached`.
 *
 * The unit test in `unitTests/components/packageComponent.test.js` plants the link directly; this one earns
 * it the way production does — deploy with `restart: true` so a serving worker loads the component — which
 * is the half a packer-only test cannot show.
 *
 * Run: npm run test:integration -- "integrationTests/deploy/package-loaded-component.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'pkg-loaded-probe';

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

/** A component with a loadable resource, so a worker actually loads it and plants the link. */
async function buildPayload(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'pkg-loaded-fixture-'));
	try {
		await writeFile(join(dir, 'package.json'), JSON.stringify({ name: PROJECT, version: '1.0.0' }));
		await writeFile(join(dir, 'config.yaml'), 'rest: true\njsResource:\n  files: resource.js\n');
		await writeFile(
			join(dir, 'resource.js'),
			'export class PkgLoadedProbe extends Resource {\n\tget() {\n\t\treturn { ok: true };\n\t}\n}\n'
		);
		await mkdir(join(dir, 'web'), { recursive: true });
		await writeFile(join(dir, 'web', 'index.html'), '<!doctype html><title>probe</title>\n');
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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
			const deadline = Date.now() + 45_000;
			while (true) {
				try {
					const probe = await fetch(`${ctx.harper.httpURL}/PkgLoadedProbe/`);
					if (probe.status < 500) break;
				} catch {
					// not accepting connections yet
				}
				if (Date.now() > deadline) throw new Error('Timed out waiting for the component to load after restart');
				await sleep(250);
			}

			const livePath = join(ctx.harper.dataRootDir, 'components', PROJECT);
			ok(existsSync(join(livePath, 'resource.js')), 'the component is live');
			// The link is expected to be here — this test is about the packer not following it, not about
			// preventing it. If a future change stops creating it, this test stops proving anything, so assert
			// its presence rather than silently passing.
			ok(existsSync(join(livePath, 'node_modules', 'harper')), 'a worker load planted the harper link');

			const estimate = await operation(ctx, { operation: 'package_component', project: PROJECT, estimate: true });
			ok(
				estimate.total_size < 1_000_000,
				`packaging walked the install (${estimate.total_size} bytes for a handful of small files)`
			);

			// And the real thing, not just the estimate: the payload comes back rather than failing on size.
			const packaged = await operation(ctx, { operation: 'package_component', project: PROJECT });
			ok(typeof packaged.payload === 'string' && packaged.payload.length > 0, 'a payload was produced');
			ok(packaged.payload.length < 2_000_000, `payload carries the install (${packaged.payload.length} base64 chars)`);
		});
	}
);
