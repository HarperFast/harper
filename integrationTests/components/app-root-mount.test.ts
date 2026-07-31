/**
 * Root-config application mount.
 *
 * Where an application is served is a deployment concern, so the operator declares it on the
 * application's entry in the root config — not in the application's checked-in config.yaml:
 *
 *   my-app:
 *     host: api.example.com
 *     urlPath: /v1
 *
 * Before this, `host`/`urlPath` on a root-config application entry were inert: an application's
 * plugin scopes read the application's own config.yaml, and nothing carried the root entry's
 * routing down to them. `deploy_component urlPath=...` persisted a value that changed nothing.
 *
 * The mount composes with (rather than replaces) the plugin's own `urlPath`, so app-internal
 * structure survives relocation: mount `/v1` + `static: { urlPath: assets }` → `/v1/assets`.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/app-root-mount.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/app-root-mount');
const APP_NAME = 'app-root-mount';
const MOUNT_HOST = 'api.example.test';

/** fetch() forbids setting Host, so drive the virtual-host cases over node:http. */
function getWithHost(url: URL, host: string): Promise<{ status: number; body: string; location?: string }> {
	return new Promise((resolvePromise, reject) => {
		const req = request(
			{ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers: { host } },
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () =>
					resolvePromise({ status: res.statusCode!, body, location: res.headers.location as string | undefined })
				);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

suite('application mounted by urlPath in the root config', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { [APP_NAME]: { urlPath: '/v1' } },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('serves the app under the mount composed with the plugin urlPath', async () => {
		const res = await fetch(new URL('/v1/assets/test.css', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /v1/assets/test.css to serve: ${res.status} ${text}`);
		ok(text.includes('teal'), 'served the fixture css content');
	});

	test('does not serve at the unmounted path the app config alone would imply', async () => {
		const res = await fetch(new URL('/assets/test.css', ctx.harper.httpURL));
		strictEqual(res.status, 404);
	});

	test('does not serve at the mount root without the app-internal prefix', async () => {
		const res = await fetch(new URL('/v1/test.css', ctx.harper.httpURL));
		strictEqual(res.status, 404);
	});

	test('serves a directory index under the mount', async () => {
		const res = await fetch(new URL('/v1/assets/docs/', ctx.harper.httpURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected /v1/assets/docs/ to serve index.html: ${res.status} ${text}`);
		ok(text.includes('docs index'));
	});

	test('redirects to a Location that includes the mount prefix', async () => {
		const res = await fetch(new URL('/v1/assets/docs', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(res.status, 301);
		strictEqual(res.headers.get('location'), '/v1/assets/docs/');
	});

	test('redirects the mount root to its trailing-slash form', async () => {
		const res = await fetch(new URL('/v1/assets', ctx.harper.httpURL), { redirect: 'manual' });
		strictEqual(res.status, 301);
		strictEqual(res.headers.get('location'), '/v1/assets/');
	});

	// Resource paths are derived from entry URL paths, and the router strips the mount before REST
	// resolves them — so those paths must stay mount-relative. Composing the mount into the entry
	// pipeline instead registered the table at '/v1/MountedThing' while REST looked up
	// 'MountedThing', 404ing every mounted REST route.
	test('a table exported by a mounted application is served under the mount', async () => {
		const res = await fetch(new URL('/v1/MountedThing', ctx.harper.httpURL));
		strictEqual(res.status, 200, `expected /v1/MountedThing to serve: ${res.status} ${await res.text()}`);
	});

	test('the mounted REST route round-trips a record', async () => {
		const put = await fetch(new URL('/v1/MountedThing/abc', ctx.harper.httpURL), {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'mounted' }),
		});
		ok(put.status < 300, `expected the write to succeed: ${put.status} ${await put.text()}`);
		const get = await fetch(new URL('/v1/MountedThing/abc', ctx.harper.httpURL));
		strictEqual(get.status, 200);
		strictEqual(((await get.json()) as { name?: string }).name, 'mounted');
	});
});

suite('application mounted by host in the root config', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { [APP_NAME]: { host: MOUNT_HOST } },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('serves the app on the configured virtual host', async () => {
		const res = await getWithHost(new URL('/assets/test.css', ctx.harper.httpURL), MOUNT_HOST);
		strictEqual(res.status, 200, `expected the mounted host to serve: ${res.status} ${res.body}`);
		ok(res.body.includes('teal'));
	});

	test('does not serve the app on a different host', async () => {
		const res = await getWithHost(new URL('/assets/test.css', ctx.harper.httpURL), 'other.example.test');
		strictEqual(res.status, 404);
	});

	test('ignores the port when matching the host', async () => {
		const url = new URL('/assets/test.css', ctx.harper.httpURL);
		const res = await getWithHost(url, `${MOUNT_HOST}:${url.port}`);
		strictEqual(res.status, 200, `expected host match to ignore the port: ${res.status} ${res.body}`);
	});
});

suite('application mounted by host and urlPath together', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { [APP_NAME]: { host: MOUNT_HOST, urlPath: '/v1' } },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('requires both to match', async () => {
		const url = new URL('/v1/assets/test.css', ctx.harper.httpURL);
		const onMount = await getWithHost(url, MOUNT_HOST);
		strictEqual(onMount.status, 200, `expected host+path to serve: ${onMount.status} ${onMount.body}`);

		const wrongHost = await getWithHost(url, 'other.example.test');
		strictEqual(wrongHost.status, 404, 'right path, wrong host must not serve');

		const wrongPath = await getWithHost(new URL('/assets/test.css', ctx.harper.httpURL), MOUNT_HOST);
		strictEqual(wrongPath.status, 404, 'right host, wrong path must not serve');
	});
});
