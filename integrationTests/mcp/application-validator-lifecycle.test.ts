/**
 * A Bearer validator that is gone does not authenticate a request and is not named in a new request's 401,
 * and the public MCP server card ignores credentials and forwarded hosts (#4346, #4347, #3314):
 * docs/reference/http/api.md (`server.registerBearerValidator`) and docs/reference/mcp/configuration.md
 * (`authentication.required`, `serverCard`).
 *
 * One worker: registrations are per worker thread, and the control route changes the worker that answers it.
 */
import http from 'node:http';
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-validator-lifecycle');
const M1 = 'https://auth1.lifecycle.test/.well-known/oauth-protected-resource/mcp';
const M2 = 'https://auth2.lifecycle.test/.well-known/oauth-protected-resource/mcp';
const MF_HOST = 'authf.lifecycle.test';
const CARD = { name: 'test.harper/validator-lifecycle', description: 'Validator lifecycle card' };
const CARD_KEYS = ['$schema', 'description', 'name', 'remotes', 'version'];
const NOTE_ID = 'lifecycle-note';
// under V2's 30 s validator deadline (fixture), which answers a held call with a 401 of its own
const HELD_CALL_LIMIT_MS = 20_000;

interface Resp {
	status: number;
	headers: http.IncomingHttpHeaders;
	text: string;
}
interface ControlState {
	v2Registered: boolean;
	afterV2Registered: boolean;
	pendingHolds: number;
	calls: Record<string, number>;
	threadId: number;
}

// node:http rather than fetch: the card tests send a `Host` that differs from the address they connect to.
function send(
	base: URL,
	o: { method: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<Resp> {
	return new Promise((resolvePromise, reject) => {
		const headers: Record<string, string> = { ...o.headers };
		if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
		const r = http.request(
			{
				host: base.hostname,
				port: base.port,
				method: o.method,
				path: o.path,
				headers,
				setHost: false,
				agent: false,
				timeout: 40_000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c));
				res.on('error', reject);
				res.on('end', () =>
					resolvePromise({
						status: res.statusCode!,
						headers: res.headers,
						text: Buffer.concat(chunks).toString('utf8'),
					})
				);
			}
		);
		r.on('timeout', () => r.destroy(new Error(`timeout ${o.method} ${o.path}`)));
		r.on('error', reject);
		if (o.body !== undefined) r.write(o.body);
		r.end();
	});
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const wa = (r: Resp) => String(r.headers['www-authenticate'] ?? '');
const names = (r: Resp, url: string) => wa(r).includes(`resource_metadata="${url}"`);
const namesNothing = (r: Resp) => !wa(r).includes('resource_metadata');
const refusedAsInvalidToken = (r: Resp) => wa(r).includes('error="invalid_token"');

suite(
	'MCP application profile: Bearer validator lifecycle and the public server card',
	{ concurrency: false },
	(ctx: ContextWithHarper) => {
		let base: URL;
		let hostHeader: string;
		let adminAuth: string;
		let markerDir: string | undefined;

		const rawMount = (authorization?: string) =>
			send(base, {
				method: 'POST',
				path: '/mcp',
				headers: {
					'host': hostHeader,
					'content-type': 'application/json',
					'accept': 'application/json, text/event-stream',
					...(authorization ? { authorization } : {}),
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
			});
		function checked(r: Resp): Resp {
			ok(!wa(r).includes(MF_HOST), `a ${r.status} names the failed plugin's metadata URL: ${wa(r)}`);
			return r;
		}
		const mount = (authorization?: string) => rawMount(authorization).then(checked);
		const note = (authorization?: string) =>
			send(base, {
				method: 'GET',
				path: `/LifecycleNote/${NOTE_ID}`,
				headers: { host: hostHeader, accept: 'application/json', ...(authorization ? { authorization } : {}) },
			}).then(checked);

		async function ops(body: object) {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'authorization': adminAuth },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(20_000),
			});
			const text = await res.text();
			return { status: res.status, text };
		}
		async function control(action: string): Promise<ControlState> {
			const r = await send(base, {
				method: 'POST',
				path: '/LifecycleControl/',
				headers: { 'host': hostHeader, 'content-type': 'application/json', 'authorization': adminAuth },
				body: JSON.stringify({ action }),
			});
			strictEqual(r.status, 200, `control ${action}: ${r.status} ${r.text}`);
			return JSON.parse(r.text);
		}
		const state = () => control('state');
		const callsOf = async (token: string) => (await state()).calls[token] ?? 0;
		async function setV2Registered(registered: boolean) {
			if ((await state()).v2Registered !== registered) await control(registered ? 'register-v2' : 'unregister-v2');
			strictEqual((await state()).v2Registered, registered);
		}

		before(async () => {
			markerDir = mkdtempSync(join(tmpdir(), 'mcp-validator-lifecycle-'));
			const failedLoadMarker = join(markerDir, 'fails-registered');
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					// no cache flush during the suite: one test counts validator calls to show a cache hit
					authentication: { authorizeLocal: false, cacheTTL: 600_000 },
					mcp: { application: { stateless: true, authentication: { required: true }, serverCard: CARD } },
				},
				env: {
					AUTHENTICATION_AUTHORIZELOCAL: 'false',
					MCP_VALIDATOR_LIFECYCLE_MARKER: failedLoadMarker,
					HARPER_BUILTIN_COMPONENTS:
						'mcpLifecycleLoads=@/integrationTests/fixtures/mcp-validator-lifecycle/loads.js,' +
						'mcpLifecycleFails=@/integrationTests/fixtures/mcp-validator-lifecycle/fails.js',
				},
			});
			base = new URL(ctx.harper.httpURL);
			hostHeader = base.host;
			adminAuth = basic(ctx.harper.admin.username, ctx.harper.admin.password);
			const deadline = Date.now() + 60_000;
			for (;;) {
				const probe = await send(base, {
					method: 'GET',
					path: '/LifecycleNote/',
					headers: { host: hostHeader, authorization: adminAuth, accept: 'application/json' },
				}).catch(() => undefined);
				if (probe?.status === 200) break;
				if (Date.now() > deadline) throw new Error(`/LifecycleNote/ never became ready (last: ${probe?.status})`);
				await sleep(250);
			}
			const password = `Pw-${randomBytes(12).toString('hex')}`;
			let r = await ops({
				operation: 'add_role',
				role: 'lifecycle_reader',
				permission: {
					super_user: false,
					data: {
						tables: {
							LifecycleNote: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			});
			strictEqual(r.status, 200, r.text);
			// the authorization cache is keyed by the header, and a fixture token names its user
			for (const username of ['reader_one', 'reader_two', 'reader_three']) {
				r = await ops({ operation: 'add_user', username, password, role: 'lifecycle_reader', active: true });
				strictEqual(r.status, 200, r.text);
			}
			r = await ops({
				operation: 'insert',
				schema: 'data',
				table: 'LifecycleNote',
				records: [{ id: NOTE_ID, owner: 'reader_one' }],
			});
			strictEqual(r.status, 200, r.text);
			const settleDeadline = Date.now() + 30_000;
			for (;;) {
				const loaded = (await rawMount('Bearer loads-good-reader_one')).status === 200;
				if (loaded && existsSync(`${failedLoadMarker}-${(await state()).threadId}`)) break;
				if (Date.now() > settleDeadline) throw new Error(`plugins never settled (loads.js authenticates: ${loaded})`);
				await sleep(250);
			}
		});
		after(async () => {
			try {
				await teardownHarper(ctx);
			} finally {
				if (markerDir) rmSync(markerDir, { recursive: true, force: true });
			}
		});

		test('one worker answers, a credential-less operations call is refused, a registered validator authenticates', async () => {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			await res.text();
			strictEqual(res.status, 401, 'credential-less operations call must be 401 (authorizeLocal off)');
			const states = await Promise.all(Array.from({ length: 20 }, () => state()));
			const threads = new Set(states.map((s) => s.threadId));
			strictEqual(threads.size, 1, `the control route was answered by threads ${[...threads]}`);
			const accepted = await mount('Bearer v1-good-reader_one');
			strictEqual(accepted.status, 200, accepted.text);
		});

		test('a plugin whose load failed leaves no validator behind', async () => {
			// with V2 gone, every live validator that declares a URL (V1, loads.js) declares M1
			await setV2Registered(false);
			try {
				const refused = await mount('Bearer fails-bad');
				strictEqual(refused.status, 401);

				const failedOnMount = await mount('Bearer fails-good-reader_one');
				const failedOnRest = await note('Bearer fails-good-reader_one');
				strictEqual(failedOnMount.status, 401, `fails.js token on /mcp: ${failedOnMount.text.slice(0, 200)}`);
				strictEqual(failedOnRest.status, 401, `fails.js token on REST: ${failedOnRest.text.slice(0, 200)}`);

				// headers no earlier request cached, so each control runs loads.js's validator
				const loadedOnMount = await mount('Bearer loads-good-reader_two');
				const loadedOnRest = await note('Bearer loads-good-reader_three');
				strictEqual(loadedOnMount.status, 200, `loads.js token on /mcp: ${loadedOnMount.text.slice(0, 200)}`);
				strictEqual(loadedOnRest.status, 200, `loads.js token on REST: ${loadedOnRest.text.slice(0, 200)}`);

				// it would name nothing if the failed plugin's MF were still declared beside M1
				const noCredential = await mount();
				strictEqual(noCredential.status, 401);
				ok(names(noCredential, M1), `no credential: ${wa(noCredential)}`);
			} finally {
				await setV2Registered(true);
			}
		});

		test('a validator unregistered at runtime stops authenticating and stops being named', async () => {
			await setV2Registered(true);
			try {
				// one cached header per route, so each route's request after the unregister finds its own cache entry
				const onMount = 'Bearer v2-good-reader_one';
				const onRest = 'Bearer v2-good-reader_two';
				strictEqual((await mount(onMount)).status, 200);
				strictEqual((await mount(onMount)).status, 200);
				strictEqual((await note(onRest)).status, 200);
				strictEqual((await note(onRest)).status, 200);
				strictEqual(await callsOf('v2-good-reader_one'), 1, 'the second /mcp request was served from the cache');
				strictEqual(await callsOf('v2-good-reader_two'), 1, 'the second REST request was served from the cache');
				const refused = await mount('Bearer v2-bad');
				strictEqual(refused.status, 401);
				ok(names(refused, M2), `registered, v2-bad: ${wa(refused)}`);
				// M1 and M2 disagree, so a request with no credential is pointed at neither
				const noCredential = await mount();
				strictEqual(noCredential.status, 401);
				ok(namesNothing(noCredential), `registered, no credential: ${wa(noCredential)}`);

				await setV2Registered(false);
				const goneOnMount = await mount(onMount);
				const goneOnRest = await note(onRest);
				strictEqual(goneOnMount.status, 401, `unregistered, /mcp: ${goneOnMount.text.slice(0, 200)}`);
				strictEqual(goneOnRest.status, 401, `unregistered, REST: ${goneOnRest.text.slice(0, 200)}`);
				ok(!names(goneOnMount, M2), `unregistered, /mcp names M2: ${wa(goneOnMount)}`);
				strictEqual(await callsOf('v2-good-reader_one'), 1, 'V2 ran after it was unregistered');
				strictEqual(await callsOf('v2-good-reader_two'), 1, 'V2 ran after it was unregistered');
				const goneNoCredential = await mount();
				strictEqual(goneNoCredential.status, 401);
				ok(names(goneNoCredential, M1), `unregistered, no credential: ${wa(goneNoCredential)}`);
				const goneRefused = await mount('Bearer v2-bad');
				strictEqual(goneRefused.status, 401);
				ok(!names(goneRefused, M2), `unregistered, v2-bad names M2: ${wa(goneRefused)}`);

				await setV2Registered(true);
				const backAccepted = await mount(onMount);
				strictEqual(backAccepted.status, 200, backAccepted.text);
				const backRefused = await mount('Bearer v2-bad');
				strictEqual(backRefused.status, 401);
				ok(names(backRefused, M2), `re-registered, v2-bad: ${wa(backRefused)}`);
			} finally {
				await setV2Registered(true);
			}
		});

		async function heldRequest(token: string, unregister: boolean): Promise<Resp> {
			await setV2Registered(true);
			await control('reset-gate');
			const started = Date.now();
			let settled: { response?: Resp; error?: unknown; at: number } | undefined;
			const inflight = mount(`Bearer ${token}`).then(
				(response) => (settled = { response, at: Date.now() }),
				(error) => (settled = { error, at: Date.now() })
			);
			let failure: unknown;
			try {
				for (;;) {
					const current = await state();
					if (current.pendingHolds === 1) break;
					if (settled) {
						const outcome = settled.response ? `${settled.response.status} ${wa(settled.response)}` : settled.error;
						throw new Error(`${token} was answered before V2 held it: ${outcome}`, { cause: settled.error });
					}
					if (Date.now() - started > 10_000) throw new Error(`${token} never reached V2: ${JSON.stringify(current)}`);
					await sleep(20);
				}
				if (unregister) await setV2Registered(false);
			} catch (error) {
				failure = error;
			}
			const cleanup = [
				async () => {
					for (let attempt = 0; ; attempt++) {
						try {
							return await control('open-gate');
						} catch (error) {
							if (attempt === 2) throw error;
							await sleep(100);
						}
					}
				},
				() => inflight,
				() => setV2Registered(true),
			];
			for (const step of cleanup) {
				await step().catch((error) => {
					failure ??= error;
				});
			}
			if (failure) throw failure;
			if (!settled?.response) throw settled?.error ?? new Error(`${token} was never answered`);
			const held = settled.at - started;
			ok(held < HELD_CALL_LIMIT_MS, `the held call took ${held} ms, so V2's deadline may have answered it`);
			return settled.response;
		}

		test('a validator unregistered while its accepting call is awaited does not authenticate', async () => {
			const token = 'v2-hold-good-reader_one';
			const stillRegistered = await heldRequest(token, false);
			strictEqual(stillRegistered.status, 200, `control: ${stillRegistered.text.slice(0, 200)}`);
			const unregistered = await heldRequest(token, true);
			strictEqual(unregistered.status, 401, `unregistered mid-call: ${unregistered.text.slice(0, 200)}`);
			ok(refusedAsInvalidToken(unregistered), `refused as a fault or a timeout: ${wa(unregistered)}`);
			strictEqual(await callsOf(token), 2);
		});

		test('a validator unregistered while its refusing call is awaited still ends the chain', async () => {
			const token = 'v2-hold-bad';
			await setV2Registered(true);
			try {
				await control('register-after-v2');
				const stillRegistered = await heldRequest(token, false);
				strictEqual(stillRegistered.status, 401);
				ok(names(stillRegistered, M2), `control: ${wa(stillRegistered)}`);
				// #4489 decides which metadata URL this 401 names, so the URL is not pinned
				const unregistered = await heldRequest(token, true);
				strictEqual(unregistered.status, 401, `unregistered mid-call: ${unregistered.text.slice(0, 200)}`);
				ok(refusedAsInvalidToken(unregistered), `refused as a fault or a timeout: ${wa(unregistered)}`);
				strictEqual(unregistered.text, stillRegistered.text, "the refusal is V2's own, as in the control");
				strictEqual(await callsOf('after-v2'), 0, 'the validator after V2 ran although V2 threw');
				await setV2Registered(false);
				const withoutV2 = await mount(`Bearer ${token}`);
				strictEqual(withoutV2.status, 200, `without V2: ${withoutV2.text.slice(0, 200)}`);
				strictEqual(await callsOf('after-v2'), 1);
			} finally {
				await control('unregister-after-v2');
				await setV2Registered(true);
			}
		});

		const card = (host: string, extra: Record<string, string> = {}) =>
			send(base, { method: 'GET', path: '/mcp/server-card', headers: { host, ...extra } }).then(checked);
		const cardKeys = (r: Resp) => Object.keys(JSON.parse(r.text)).sort();

		test('the card names the request Host and ignores X-Forwarded-Host', async () => {
			for (const host of ['a.lifecycle.test', 'a.lifecycle.test:8443', '[::1]:9926', 'A.LIFECYCLE.TEST']) {
				const r = await card(host);
				strictEqual(r.status, 200, `${host}: ${r.status} ${r.text.slice(0, 200)}`);
				strictEqual(r.headers['content-type'], 'application/mcp-server-card+json', host);
				deepStrictEqual(cardKeys(r), CARD_KEYS);
				strictEqual(new URL(JSON.parse(r.text).remotes[0].url).href, new URL(`http://${host}/mcp`).href, host);
			}
			const plain = await card('a.lifecycle.test');
			const forwarded = await card('a.lifecycle.test', { 'x-forwarded-host': 'other.lifecycle.test' });
			strictEqual(forwarded.text, plain.text);
			ok(plain.headers.etag, 'the card has an ETag');
			strictEqual(forwarded.headers.etag, plain.headers.etag);
			ok(String(plain.headers.vary).toLowerCase().split(/,\s*/).includes('host'), `Vary: ${plain.headers.vary}`);
		});

		test('an unusual Host reaches no response header and no later response', async () => {
			const expected = (await card('a.lifecycle.test')).text;
			strictEqual(JSON.parse(expected).remotes[0].url, 'http://a.lifecycle.test/mcp');
			const hosts = [
				'user@a.lifecycle.test',
				'a.lifecycle.test/x?y=1',
				'a.lifecycle.test"x',
				'a.lifecycle.test\\x',
				'<b>a.lifecycle.test',
				'a'.repeat(1990) + '.test',
			];
			for (const host of hosts) {
				const label = host.length > 40 ? `${host.slice(0, 20)}... (${host.length} characters)` : host;
				const r = await card(host);
				ok(r.status === 200 || (r.status >= 400 && r.status < 500), `${label}: ${r.status}`);
				if (r.status === 200) deepStrictEqual(cardKeys(r), CARD_KEYS, label);
				for (const [name, value] of Object.entries(r.headers)) {
					ok(!String(value).includes(host), `response header ${name} contains the Host text (${label})`);
				}
				const next = await card('a.lifecycle.test');
				strictEqual(next.text, expected, `the request after ${label} got a body shaped by it`);
			}
		});

		test('credentials do not change the card, and the card runs no validator', async () => {
			const faultOnMount = await mount('Bearer v1-fault');
			strictEqual(faultOnMount.status, 401, `v1-fault on the mount: ${faultOnMount.status}`);
			ok(!refusedAsInvalidToken(faultOnMount), `v1-fault was refused as a token: ${wa(faultOnMount)}`);
			strictEqual((await mount('Bearer v1-bad')).status, 401);
			const callsBefore = (await state()).calls;
			ok(callsBefore['v1-fault'] >= 1 && callsBefore['v1-bad'] >= 1, JSON.stringify(callsBefore));

			const credentials = [
				undefined,
				'Bearer fails-good-reader_one',
				'Bearer v1-bad',
				'Bearer v1-fault',
				adminAuth,
				basic(ctx.harper.admin.username, 'not-the-password'),
			];
			const cards: Resp[] = [];
			for (const authorization of credentials) {
				cards.push(await card('a.lifecycle.test', authorization ? { authorization } : {}));
			}
			for (const r of cards) {
				strictEqual(r.status, 200);
				strictEqual(r.text, cards[0].text);
				strictEqual(r.headers.etag, cards[0].headers.etag);
				strictEqual(r.headers['content-type'], cards[0].headers['content-type']);
				strictEqual(r.headers['www-authenticate'], undefined);
			}
			deepStrictEqual((await state()).calls, callsBefore, 'a card request reached a validator');
		});
	}
);
