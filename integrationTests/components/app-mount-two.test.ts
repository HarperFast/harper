/**
 * Two applications, two distinct root-config mounts.
 *
 * This is the headline use case for root-config routing, and it exposed a bug the single-app
 * case cannot: `server/REST.ts` guarded registration with a module-level `started` boolean, so
 * only the first-loaded application's REST chain was ever registered and the second mounted
 * application's REST API silently 404'd. Registration is now keyed per route mount.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/app-mount-two.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/app-mount-two');

suite('two applications mounted at different root-config paths', (ctx: ContextWithHarper) => {
	before(async () => {
		// Both apps must land directly under components/, so stage the data root rather than using
		// setupHarperWithFixture (which copies a single fixture dir as one component).
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		for (const app of ['app-one', 'app-two']) {
			await cp(join(FIXTURE_PATH, app), join(dataRootDir, 'components', app), { recursive: true, dereference: true });
		}
		ctx.harper = { dataRootDir };
		await startHarper(ctx, {
			config: {
				'app-one': { urlPath: '/one' },
				'app-two': { urlPath: '/two' },
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the first mounted application serves REST under its own mount', async () => {
		const res = await fetch(new URL('/one/MountOne', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /one/MountOne to serve: ${res.status} ${text}`);
	});

	test('the second mounted application also serves REST under its own mount', async () => {
		// Before the per-mount registration fix this 404'd: REST registered only once per process.
		const res = await fetch(new URL('/two/MountTwo', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /two/MountTwo to serve: ${res.status} ${text}`);
	});

	// A mount relocates the REST *handler*, it does not namespace resources: exported tables live in
	// one instance-wide registry, so either mount resolves either table. Asserted so the boundary is
	// explicit — a mount is routing, not isolation.
	test('a mount is a routing prefix, not a resource namespace', async () => {
		const crossed = await fetch(new URL('/one/MountTwo', ctx.harper.httpURL));
		strictEqual(crossed.status, 200, 'exported tables are instance-wide, reachable through either mount');
	});

	test('neither application is served at the unmounted root', async () => {
		const res = await fetch(new URL('/MountOne', ctx.harper.httpURL));
		ok(res.status >= 400, `expected /MountOne to not resolve, got ${res.status}`);
	});

	test('a record written through one mount reads back through it', async () => {
		const put = await fetch(new URL('/one/MountOne/abc', ctx.harper.httpURL), {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'from mount one' }),
		});
		ok(put.status < 300, `expected the write to succeed: ${put.status} ${await put.text()}`);

		const get = await fetch(new URL('/one/MountOne/abc', ctx.harper.httpURL));
		strictEqual(get.status, 200);
		const record = (await get.json()) as { name?: string };
		strictEqual(record.name, 'from mount one');
	});
});
