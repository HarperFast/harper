/**
 * Static `after: 'rest'` ordering — harper#1574.
 *
 * Pins: an SPA app with `fallthrough: false` + `after: 'rest'` keeps REST reachable
 * (not swallowed by the static catch-all), auth denials are not swallowed by the SPA
 * fallthrough, unmatched client routes still fall back to the SPA shell, and the
 * misconfiguration warning fires when `fallthrough: false` is used WITHOUT `after: 'rest'`.
 *
 * Run: npm run test:integration -- "integrationTests/components/static-after-rest.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-after-rest');
const MISCONFIG_FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/static-after-rest-misconfig');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
// A fragment unique to server/static.ts's `fallthrough: false` misconfiguration warning — distinctive
// enough that polling for it (rather than the ambiguous `/after: 'rest'/`, which also matches the
// config option name itself) can't false-positive on unrelated startup log lines.
const MISCONFIG_WARNING_FRAGMENT = 'answers every unmatched GET itself';

const ALICE = { username: 'qa516_alice', password: 'Alice-pw-1574!' };
const BOB = { username: 'qa516_bob', password: 'Bob-pw-1574!' };
const ROLE = 'qa516_secret_reader';
const NOPERM_ROLE = 'qa516_no_secret';

suite('static after: rest ordering (#1574)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL = '';
	let aliceHeaders: Record<string, string>;
	let bobHeaders: Record<string, string>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		aliceHeaders = createHeaders(ALICE.username, ALICE.password);
		bobHeaders = createHeaders(BOB.username, BOB.password);

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Product/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(200);
		}

		await client
			.req()
			.send({
				operation: 'add_role',
				role: ROLE,
				permission: {
					super_user: false,
					data: {
						tables: {
							Secret: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			})
			.expect(200);

		await client
			.req()
			.send({ operation: 'add_user', role: ROLE, username: ALICE.username, password: ALICE.password, active: true })
			.expect(200);

		await client
			.req()
			.send({
				operation: 'add_role',
				role: NOPERM_ROLE,
				permission: {
					super_user: false,
					data: {
						tables: {
							Secret: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			})
			.expect(200);

		await client
			.req()
			.send({ operation: 'add_user', role: NOPERM_ROLE, username: BOB.username, password: BOB.password, active: true })
			.expect(200);

		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'data',
				table: 'Product',
				records: [{ id: 'p-1', name: 'Widget', price: 9.99 }],
			})
			.expect(200);

		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'data',
				table: 'Secret',
				records: [{ id: 's-1', value: 'top-secret' }],
			})
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('REST reachability: GET /Product/<id> hits REST, not the SPA fallback', async () => {
		const res = await client.reqRest('/Product/p-1');
		const text = res.text ?? '';
		ok(!text.includes('spa-shell-marker'), `REST route must not be swallowed by the SPA fallback: got ${text}`);
		strictEqual(res.status, 200, `expected the REST handler to serve Product/p-1: ${res.status} ${text}`);
		strictEqual(res.body.name, 'Widget', `expected REST JSON body, got: ${text}`);
	});

	test('SPA fallback still works for a genuinely unmatched client route', async () => {
		const res = await fetch(new URL('/some/totally/unmatched/client-route', restURL));
		const text = await res.text();
		strictEqual(res.status, 200, `expected the SPA notFound fallback to serve index.html: ${res.status} ${text}`);
		ok(text.includes('spa-shell-marker'), `expected the SPA shell body, got: ${text}`);
	});

	test('auth ordering: headerless GET is auto-authorized as super_user in the test harness (loopback bypass, not a #1574 defect)', async () => {
		// AUTHENTICATION_AUTHORIZELOCAL is unconditionally true in the test harness — loopback
		// requests bypass auth as super_user. This assertion documents that behavior rather than
		// testing #1574's auth-ordering property; the "auth-ordering check" test below (ungranted
		// Bob) is the real check.
		const res = await fetch(new URL('/Secret/s-1', restURL));
		const text = await res.text();
		ok(!text.includes('spa-shell-marker'), `must not fall through to the SPA shell: ${res.status} ${text}`);
		strictEqual(
			res.status,
			200,
			`documenting harness bypass behavior: expected auto-authorized 200, got ${res.status} ${text}`
		);
	});

	test('control: authenticated user WITH grant reads Secret successfully', async () => {
		const res = await fetch(new URL('/Secret/s-1', restURL), { headers: aliceHeaders });
		const text = await res.text();
		strictEqual(res.status, 200, `granted user should read Secret: ${res.status} ${text}`);
		ok(text.includes('top-secret'), `expected Secret's REST JSON body, got: ${text}`);
	});

	test('auth-ordering check: authenticated user with NO grant on Secret is denied, not served the SPA shell', async () => {
		// Key regression anchor for #1574: static with `after: 'rest'` must not intercept
		// auth-gated REST paths and return the SPA shell for denied users.
		const res = await fetch(new URL('/Secret/s-1', restURL), { headers: bobHeaders });
		const text = await res.text();
		ok(
			!text.includes('spa-shell-marker'),
			`ungranted user's /Secret/s-1 must not fall through to the SPA shell: ${res.status} ${text}`
		);
		ok(
			[401, 403].includes(res.status),
			`expected a proper auth/permission denial (401/403), got ${res.status} ${text}`
		);
	});

	test('control: admin (super_user) reads Secret successfully', async () => {
		const res = await client.reqRest('/Secret/s-1');
		strictEqual(res.status, 200, `admin should read Secret: ${res.status} ${res.text}`);
		strictEqual(res.body.value, 'top-secret');
	});
});

suite(
	'static fallthrough:false WITHOUT after: rest — misconfiguration warning (#1574)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let procOutput = '';

		function readCombinedLog(): string {
			let fileLog = '';
			if (ctx.harper.logDir) {
				try {
					fileLog = readFileSync(join(ctx.harper.logDir, 'hdb.log'), 'utf8');
				} catch {
					/* fall back to procOutput */
				}
			}
			return procOutput + fileLog;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, MISCONFIG_FIXTURE_PATH, {
				config: { logging: { console: true, level: 'warn' } },
				env: {},
			});
			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			const proc = ctx.harper.process;
			proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (readCombinedLog().includes(MISCONFIG_WARNING_FRAGMENT)) break;
				await sleep(200);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('the documented warning fires in the instance logs', async () => {
			const combined = readCombinedLog();
			ok(
				combined.includes(MISCONFIG_WARNING_FRAGMENT),
				`expected the static-blocking-REST warning to be logged; captured output:\n${combined}`
			);
		});
	}
);
