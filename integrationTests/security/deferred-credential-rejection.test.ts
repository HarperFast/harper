import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/deferred-credential-rejection');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
// uWS hands a legacy route to Fastify through inject(), which carries no base request, so the
// deferred decision cannot reach hdbCore.preValidation there and passport decides the credential again.
const skipOnUws = process.env.HARPER_UWS_HTTP ? 'uWS inject() does not carry the deferred decision' : false;

const WORDPRESS_BASIC = `Basic ${Buffer.from('wordpress:abcd efgh ijkl mnop qrst uvwx').toString('base64')}`;
const basic = (username: string, password: string) =>
	`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const DOWNSTREAM_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.d29vLXNlc3Npb24.not-a-harper-token';

// must match the fixture's `server.getUser` override (fixtures/deferred-credential-rejection/resources.js)
const REJECTED_SESSION_USER = 'expired-staff';
const FAULTING_SESSION_USER = 'faulting-staff';
const BLOCKED_USER = 'blocked-staff';
const BLOCKED_PASSWORD = 'blocked-staff-password';

const BASIC_CHALLENGE = 'Basic realm="Harper"';
const BEARER_CHALLENGE = 'Bearer realm="Harper", error="invalid_token"';

// must match the fixture's Bearer validator (fixtures/deferred-credential-rejection/appCatchAll.js)
const BEARER_USER = 'ext-bearer-user';
const BEARER_ROLE = 'ext_bearer_reader';

const APP_ROUTE = '/wp-json/wc/v3/products';
const LEGACY_ROUTE = '/legacy-auth';
const PROTECTED_ROUTE = '/Ledger/';
const PUBLIC_ROUTE = '/PublicNotice/';

suite(
	'#2418 unrecognized app-port credentials defer until route ownership',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL = '';
		let adminAuthorization = '';

		async function get(pathname: string, authorization?: string, extraHeaders: Record<string, string> = {}) {
			const response = await fetch(`${restURL}${pathname}`, {
				headers: { ...(authorization ? { Authorization: authorization } : {}), ...extraHeaders },
			});
			const text = await response.text();
			let body: any;
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
			return { status: response.status, body, text, headers: response.headers };
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				// one thread, so the fixture's per-process server.getUser counter sees every call
				config: { mcp: { application: { mountPath: '/mcp' } }, threads: { count: 1 } },
				env: {
					HARPER_BUILTIN_COMPONENTS:
						'deferredAuthAppCatchAll=@/integrationTests/security/fixtures/deferred-credential-rejection/appCatchAll.js',
				},
			});
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			adminAuthorization = client.headers.Authorization;
			await client
				.req()
				.send({
					operation: 'add_role',
					role: BEARER_ROLE,
					permission: {
						super_user: false,
						data: {
							tables: {
								Ledger: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				})
				.expect(200);
			await client
				.req()
				.send({
					operation: 'add_user',
					role: BEARER_ROLE,
					username: BEARER_USER,
					password: `pw-${Date.now()}`,
					active: true,
				})
				.expect(200);

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const probe = await get(PUBLIC_ROUTE, adminAuthorization);
				if (probe.status !== 404) break;
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('the application catch-all is mounted after rest, not before it', async () => {
			const owned = await get(PUBLIC_ROUTE, adminAuthorization);
			equal(owned.status, 200);
			ok(owned.body?.servedBy !== 'application-catch-all', 'rest must own a Harper resource route');

			const unowned = await get(APP_ROUTE);
			equal(unowned.status, 200);
			equal(unowned.body.servedBy, 'application-catch-all');
		});

		test('valid Harper Basic credentials still authenticate a protected Harper resource', async () => {
			const response = await get(PROTECTED_ROUTE, adminAuthorization);

			equal(response.status, 200, `expected the admin to read ${PROTECTED_ROUTE}: ${response.text}`);
		});

		test('an unrecognized WordPress Basic credential reaches the catch-all byte-for-byte', async () => {
			const response = await get(APP_ROUTE, WORDPRESS_BASIC);

			equal(response.status, 200, `expected the catch-all to answer: ${response.text}`);
			equal(response.body.servedBy, 'application-catch-all');
			equal(response.body.authorization, WORDPRESS_BASIC);
			equal(response.body.harperUser, null);
		});

		test('a downstream-owned Bearer token gets the same treatment as Basic', async () => {
			const response = await get(APP_ROUTE, DOWNSTREAM_BEARER);

			equal(response.status, 200, `expected the catch-all to answer: ${response.text}`);
			equal(response.body.authorization, DOWNSTREAM_BEARER);
			equal(response.body.harperUser, null);
		});

		test('a protected Harper resource rejects an unrecognized credential instead of falling through', async () => {
			const response = await get(PROTECTED_ROUTE, WORDPRESS_BASIC);

			equal(response.status, 401, `expected a generic unauthorized: ${response.text}`);
			ok(response.body?.servedBy !== 'application-catch-all', 'a Harper-owned route must not reach the application');
		});

		test('a protected Harper resource rejects an invalid Harper Bearer token', async () => {
			const response = await get(PROTECTED_ROUTE, DOWNSTREAM_BEARER);

			equal(response.status, 401, `expected a generic unauthorized: ${response.text}`);
			ok(response.body?.servedBy !== 'application-catch-all');
		});

		test('an unrecognized credential never downgrades a Harper-owned route to public access', async () => {
			const anonymous = await get(PUBLIC_ROUTE);
			equal(anonymous.status, 200, `PublicNotice must stay anonymously readable: ${anonymous.text}`);
			ok(anonymous.body?.servedBy !== 'application-catch-all');

			const withUnknownCredential = await get(PUBLIC_ROUTE, WORDPRESS_BASIC);
			equal(withUnknownCredential.status, 401, `expected a generic unauthorized: ${withUnknownCredential.text}`);
			ok(withUnknownCredential.body?.servedBy !== 'application-catch-all');
		});

		test('a request with no credentials is unaffected on both owned and unowned routes', async () => {
			const owned = await get(PUBLIC_ROUTE);
			equal(owned.status, 200);

			const unowned = await get(APP_ROUTE);
			equal(unowned.status, 200);
			equal(unowned.body.servedBy, 'application-catch-all');
			equal(unowned.body.authorization, null);
			// the harness authorizes loopback requests, which run as the local principal
			equal(unowned.body.harperUser, 'local');
		});

		test('a deferred-credential response is kept out of shared caches', async () => {
			const response = await fetch(`${restURL}${APP_ROUTE}`, { headers: { Authorization: WORDPRESS_BASIC } });

			equal(response.status, 200);
			ok(
				response.headers.get('vary')?.toLowerCase().includes('authorization'),
				`expected Vary: Authorization, got ${response.headers.get('vary')}`
			);
			ok(
				/private|no-store/i.test(response.headers.get('cache-control') ?? ''),
				`expected a private cache scope, got ${response.headers.get('cache-control')}`
			);
		});

		test('a rejected credential on a REST route keeps the authentication error envelope', async () => {
			const response = await get(PROTECTED_ROUTE, WORDPRESS_BASIC, { Accept: 'application/json' });

			equal(response.status, 401, `expected a generic unauthorized: ${response.text}`);
			equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
			equal(typeof response.body?.error, 'string', `expected an {error} body, got: ${response.text}`);
			ok(response.body.title === undefined, `expected no Problem Details envelope, got: ${response.text}`);
			ok(response.body.errors === undefined, `expected no GraphQL error envelope, got: ${response.text}`);
		});

		test('a rejected credential on /graphql keeps the same envelope, not GraphQL errors', async () => {
			const response = await fetch(`${restURL}/graphql?query=%7B__typename%7D`, {
				headers: { Authorization: WORDPRESS_BASIC, Accept: 'application/json' },
			});
			const text = await response.text();

			equal(response.status, 401, `expected a generic unauthorized: ${text}`);
			equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
			const body = JSON.parse(text);
			equal(typeof body.error, 'string', `expected an {error} body, got: ${text}`);
			ok(body.errors === undefined, `expected no GraphQL {errors:[...]} envelope, got: ${text}`);
		});

		test('/graphql still answers an anonymous request normally', async () => {
			const response = await fetch(`${restURL}/graphql?query=%7B__typename%7D`, {
				headers: { Accept: 'application/json' },
			});

			ok(response.status !== 401, `an anonymous /graphql request must not be rejected: ${await response.text()}`);
		});

		test('the operations API still rejects an unrecognized credential in place', async () => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': WORDPRESS_BASIC, 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
			});

			equal(response.status, 401);
		});

		async function mintSessionCookie(user: string) {
			const response = await fetch(`${restURL}/mint-session?user=${encodeURIComponent(user)}`);
			equal(response.status, 200, `expected the fixture to mint a session: ${await response.text()}`);
			const setCookie = response.headers.get('set-cookie');
			ok(setCookie, 'the session route must return a Set-Cookie');
			return setCookie.split(';')[0];
		}

		test('a rejected cookie session reaches an application-owned route instead of a raw error page', async () => {
			const cookie = await mintSessionCookie(REJECTED_SESSION_USER);

			const response = await get(APP_ROUTE, undefined, { Cookie: cookie });

			equal(response.status, 200, `the application must still be served: ${response.text}`);
			equal(response.body.servedBy, 'application-catch-all');
			equal(response.body.harperUser, null);
			ok(!response.text.startsWith('ClientError'), `the raw error must not be the body: ${response.text}`);
		});

		test('a rejected cookie session gets the negotiated 401 envelope on a Harper-owned route', async () => {
			const cookie = await mintSessionCookie(REJECTED_SESSION_USER);

			const response = await get(PROTECTED_ROUTE, undefined, { Cookie: cookie, Accept: 'application/json' });

			equal(response.status, 401, `expected an unauthorized: ${response.text}`);
			equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
			equal(response.body?.error, 'SSO session expired');
			ok(response.body?.title === undefined, `expected no Problem Details envelope: ${response.text}`);
		});

		test('an internal fault resolving a cookie session fails closed with the generic message', async () => {
			const cookie = await mintSessionCookie(FAULTING_SESSION_USER);

			const response = await get(APP_ROUTE, undefined, { Cookie: cookie });

			equal(response.status, 401, `an internal fault must be decided in place: ${response.text}`);
			ok(response.body?.servedBy !== 'application-catch-all', 'an internal fault must not reach the application');
			ok(
				!/user store unavailable/.test(response.text),
				`the internal message must not reach the client: ${response.text}`
			);
		});

		test('an accepted cookie session still authenticates a Harper-owned route', async () => {
			const cookie = await mintSessionCookie(ctx.harper.admin.username);

			const response = await get(PROTECTED_ROUTE, undefined, { Cookie: cookie });

			equal(response.status, 200, `the session user must still authenticate: ${response.text}`);
		});

		async function postLegacy(authorization?: string, extraHeaders: Record<string, string> = {}) {
			const response = await fetch(`${restURL}${LEGACY_ROUTE}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(authorization ? { Authorization: authorization } : {}),
					...extraHeaders,
				},
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			const text = await response.text();
			let body: any;
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
			return { status: response.status, body, text, headers: response.headers };
		}

		async function getUserCalls(username: string): Promise<number> {
			const response = await get(`/GetUserCalls/${encodeURIComponent(username)}`, adminAuthorization);
			equal(response.status, 200, `expected the fixture to report getUser calls: ${response.text}`);
			return response.body.calls;
		}

		function assertChallengedUnauthorized(
			response: { status: number; text: string; headers: Headers },
			challenge = BASIC_CHALLENGE
		) {
			equal(response.status, 401, `expected an unauthorized: ${response.text}`);
			equal(response.headers.get('www-authenticate'), challenge);
			equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
		}

		test('valid Harper Basic credentials authenticate a legacy hdbCore.preValidation route', async () => {
			const response = await postLegacy(adminAuthorization);

			equal(response.status, 200, `expected the legacy route to answer: ${response.text}`);
			equal(response.body.servedBy, 'legacy-route');
			equal(response.body.harperUser, ctx.harper.admin.username);
		});

		test('a legacy route settles a rejected Basic credential with one getUser call', async () => {
			const username = 'legacy-unknown-basic';
			const response = await postLegacy(basic(username, 'wrong'));

			equal(response.status, 401, `expected an unauthorized: ${response.text}`);
			equal(await getUserCalls(username), 1, 'the credential must be verified once, by the middleware');
			equal(response.body.error, 'Login failed');
			assertChallengedUnauthorized(response);
		});

		test('a legacy route answers an unknown scheme exactly as a REST route does', { skip: skipOnUws }, async () => {
			const rest = await get(PROTECTED_ROUTE, 'Digest abc', { Accept: 'application/json' });
			const legacy = await postLegacy('Digest abc');

			equal(legacy.body.error, rest.body.error);
			assertChallengedUnauthorized(rest);
			assertChallengedUnauthorized(legacy);
		});

		test(
			'a legacy route settles a rejected cookie session with its own message and one getUser call',
			{ skip: skipOnUws },
			async () => {
				const username = `${REJECTED_SESSION_USER}-legacy`;
				const cookie = await mintSessionCookie(username);
				const minted = await getUserCalls(username);

				const response = await postLegacy(undefined, { Cookie: cookie });

				equal(response.status, 401, `expected an unauthorized: ${response.text}`);
				equal((await getUserCalls(username)) - minted, 1, 'the session must be resolved once, by the middleware');
				equal(response.body.error, 'SSO session expired');
				assertChallengedUnauthorized(response);
			}
		);

		test(
			"a legacy route keeps a component's rejection of a credential core Harper would accept",
			{ skip: skipOnUws },
			async () => {
				const added = await client.req().send({
					operation: 'add_user',
					username: BLOCKED_USER,
					password: BLOCKED_PASSWORD,
					role: 'super_user',
					active: true,
				});
				equal(added.status, 200, `expected the suite to create the user: ${added.text}`);

				const response = await postLegacy(basic(BLOCKED_USER, BLOCKED_PASSWORD));

				equal(response.status, 401, `the legacy route must not run for a rejected credential: ${response.text}`);
				equal(response.body.error, 'Account blocked');
				assertChallengedUnauthorized(response);
			}
		);

		test('a legacy route still accepts a refresh token for refresh_operation_token', async () => {
			const tokens = await client.req().send({
				operation: 'create_authentication_tokens',
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
			});
			equal(tokens.status, 200, `expected tokens: ${tokens.text}`);

			const response = await fetch(`${restURL}${LEGACY_ROUTE}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokens.body.refresh_token}` },
				body: JSON.stringify({ operation: 'refresh_operation_token' }),
			});
			const body = await response.json();

			equal(response.status, 200, `expected the legacy route to accept the refresh token: ${JSON.stringify(body)}`);
			equal(body.harperUser, ctx.harper.admin.username);
		});

		test('a legacy route rejects an invalid Harper Bearer token with a Bearer challenge', async () => {
			const response = await postLegacy(DOWNSTREAM_BEARER);

			equal(response.body.error, 'invalid token');
			assertChallengedUnauthorized(response, BEARER_CHALLENGE);
		});

		test('a REST route challenges a rejected credential in the scheme it presented', async () => {
			assertChallengedUnauthorized(await get(PROTECTED_ROUTE, WORDPRESS_BASIC, { Accept: 'application/json' }));
			assertChallengedUnauthorized(
				await get(PROTECTED_ROUTE, DOWNSTREAM_BEARER, { Accept: 'application/json' }),
				BEARER_CHALLENGE
			);
		});

		test('an in-place 401 for an internal fault carries a challenge and a Content-Type', async () => {
			const cookie = await mintSessionCookie(FAULTING_SESSION_USER);

			assertChallengedUnauthorized(await get(APP_ROUTE, undefined, { Cookie: cookie, Accept: 'application/json' }));
		});

		test('the operations API in-place 401 gets a Content-Type but no challenge', async () => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': WORDPRESS_BASIC, 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
			});

			equal(response.status, 401);
			equal(response.headers.get('www-authenticate'), null);
			equal(response.headers.get('content-type')?.split(';')[0], 'application/json');
		});

		test('a throwing middleware renders its class name as the error code', async () => {
			const response = await get('/throw-from-middleware');

			equal(response.status, 503);
			equal(response.text, 'Error: deliberate middleware failure');
		});

		test('a registered Bearer validator authenticates a protected Harper resource, enforces permissions, and populates request.user', async () => {
			const protectedResponse = await get(PROTECTED_ROUTE, 'Bearer ext-valid-bearer');
			equal(
				protectedResponse.status,
				200,
				`expected ext-valid-bearer to read ${PROTECTED_ROUTE}: ${protectedResponse.text}`
			);

			const writeResponse = await fetch(`${restURL}${PROTECTED_ROUTE}`, {
				method: 'POST',
				headers: {
					'Authorization': 'Bearer ext-valid-bearer',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ id: 'denied-write', note: 'read-only user must not insert' }),
			});
			equal(
				writeResponse.status,
				403,
				`expected ext-valid-bearer write to ${PROTECTED_ROUTE} to be forbidden: ${await writeResponse.text()}`
			);

			const appResponse = await get(APP_ROUTE, 'Bearer ext-valid-bearer');
			equal(appResponse.status, 200);
			equal(appResponse.body.harperUser, BEARER_USER);
		});

		test('a registered Bearer validator authenticates the native MCP application mount and filters tools/list by the mapped user permissions', async () => {
			async function listMcpTools(authorization: string): Promise<string[]> {
				const initRes = await fetch(`${restURL}/mcp`, {
					method: 'POST',
					headers: {
						'Authorization': authorization,
						'Content-Type': 'application/json',
						'Accept': 'application/json, text/event-stream',
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'initialize',
						params: {
							protocolVersion: '2025-06-18',
							capabilities: {},
							clientInfo: { name: 'bearer-validator-it', version: '0' },
						},
					}),
				});
				const initText = await initRes.text();
				equal(initRes.status, 200, `expected MCP initialize to 200: ${initText}`);
				const sessionId = initRes.headers.get('mcp-session-id');
				ok(sessionId, 'expected MCP initialize to return mcp-session-id');
				const protocolVersion = JSON.parse(initText).result.protocolVersion;

				const listRes = await fetch(`${restURL}/mcp`, {
					method: 'POST',
					headers: {
						'Authorization': authorization,
						'Content-Type': 'application/json',
						'Accept': 'application/json, text/event-stream',
						'mcp-session-id': sessionId!,
						'mcp-protocol-version': protocolVersion,
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
				});
				const listText = await listRes.text();
				equal(listRes.status, 200, `expected MCP tools/list to 200: ${listText}`);
				const listJson = JSON.parse(listText);
				return (listJson.result?.tools ?? []).map((t: { name: string }) => t.name);
			}

			const extTools = await listMcpTools('Bearer ext-valid-bearer');
			ok(extTools.includes('get_Ledger'), `expected get_Ledger in MCP tools/list, got: ${extTools.join(', ')}`);
			ok(extTools.includes('search_Ledger'), `expected search_Ledger in MCP tools/list, got: ${extTools.join(', ')}`);
			ok(!extTools.includes('create_Ledger'), `expected create_Ledger to be filtered out, got: ${extTools.join(', ')}`);
			ok(!extTools.includes('update_Ledger'), `expected update_Ledger to be filtered out, got: ${extTools.join(', ')}`);
			ok(!extTools.includes('delete_Ledger'), `expected delete_Ledger to be filtered out, got: ${extTools.join(', ')}`);

			const adminTools = await listMcpTools(adminAuthorization);
			ok(adminTools.includes('create_Ledger'), `expected admin to see create_Ledger, got: ${adminTools.join(', ')}`);
			ok(adminTools.includes('update_Ledger'), `expected admin to see update_Ledger, got: ${adminTools.join(', ')}`);
			ok(adminTools.includes('delete_Ledger'), `expected admin to see delete_Ledger, got: ${adminTools.join(', ')}`);
		});

		test('a registered Bearer validator authenticates GraphQL queries and WebSocket subscriptions on a protected Harper resource', async () => {
			const seedRes = await fetch(`${restURL}${PROTECTED_ROUTE}`, {
				method: 'POST',
				headers: {
					'Authorization': adminAuthorization,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ id: 'gql-ws-row-1', note: 'seeded-for-gql' }),
			});
			ok(seedRes.ok, `expected admin seed to succeed (${seedRes.status}): ${await seedRes.text()}`);

			const gqlRes = await fetch(`${restURL}/graphql`, {
				method: 'POST',
				headers: {
					'Authorization': 'Bearer ext-valid-bearer',
					'Content-Type': 'application/json',
					'Accept': 'application/json',
				},
				body: JSON.stringify({ query: '{ Ledger { id note } }' }),
			});
			const gqlText = await gqlRes.text();
			equal(gqlRes.status, 200, `expected GraphQL query with ext-valid-bearer to 200: ${gqlText}`);
			const gqlBody = JSON.parse(gqlText) as { data?: { Ledger?: Array<{ id: string; note: string }> } };
			ok(
				Array.isArray(gqlBody.data?.Ledger) && gqlBody.data!.Ledger.some((r) => r.id === 'gql-ws-row-1'),
				`expected GraphQL Ledger query to return seeded row, got: ${gqlText}`
			);

			const wsURL = `${restURL.replace(/^http/, 'ws')}${PROTECTED_ROUTE}`;
			const frames: string[] = [];
			const ws = new WebSocket(wsURL, {
				headers: { Authorization: 'Bearer ext-valid-bearer' },
				rejectUnauthorized: false,
			});
			try {
				await new Promise<void>((resolveOpen, rejectOpen) => {
					const timer = setTimeout(() => rejectOpen(new Error('WebSocket open timed out')), 8000);
					ws.once('open', () => {
						clearTimeout(timer);
						resolveOpen();
					});
					ws.once('error', (err) => {
						clearTimeout(timer);
						rejectOpen(err);
					});
				});
				ws.on('message', (data: Buffer) => frames.push(data.toString()));

				const pubRes = await fetch(`${restURL}${PROTECTED_ROUTE}`, {
					method: 'POST',
					headers: {
						'Authorization': adminAuthorization,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ id: 'gql-ws-row-2', note: 'published-for-ws' }),
				});
				ok(pubRes.ok, `expected admin write to succeed (${pubRes.status}): ${await pubRes.text()}`);

				const wsDeadline = Date.now() + 8000;
				while (Date.now() < wsDeadline && !frames.some((f) => f.includes('gql-ws-row-2'))) {
					await sleep(50);
				}
				ok(
					frames.some((f) => f.includes('gql-ws-row-2')),
					`expected WebSocket subscription authenticated by Bearer validator to receive gql-ws-row-2, got: ${frames.join(' | ')}`
				);
			} finally {
				ws.terminate();
			}
		});

		test('a second registered Bearer validator claims a token the first declines, and the user keeps its own role', async () => {
			const protectedResponse = await get(PROTECTED_ROUTE, 'Bearer ext-chain-bearer');
			equal(
				protectedResponse.status,
				200,
				`expected ext-chain-bearer to read ${PROTECTED_ROUTE}: ${protectedResponse.text}`
			);

			const writeResponse = await fetch(`${restURL}${PROTECTED_ROUTE}`, {
				method: 'POST',
				headers: {
					'Authorization': 'Bearer ext-chain-bearer',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ id: 'admin-bearer-write', note: 'the admin role keeps write access' }),
			});
			ok(
				writeResponse.ok,
				`expected the admin-mapped token to write ${PROTECTED_ROUTE} (${writeResponse.status}): ${await writeResponse.text()}`
			);

			const appResponse = await get(APP_ROUTE, 'Bearer ext-chain-bearer');
			equal(appResponse.status, 200);
			equal(appResponse.body.harperUser, 'admin');
		});

		test('a tagged credential rejection from a Bearer validator returns its error on a Harper route and defers on an app route', async () => {
			const protectedResponse = await get(PROTECTED_ROUTE, 'Bearer ext-rejected-bearer', {
				Accept: 'application/json',
			});
			equal(protectedResponse.status, 401);
			equal(protectedResponse.body?.error, 'external bearer token expired');

			const appResponse = await get(APP_ROUTE, 'Bearer ext-rejected-bearer');
			equal(appResponse.status, 200, `expected the catch-all to answer: ${appResponse.text}`);
			equal(appResponse.body.servedBy, 'application-catch-all');
			equal(appResponse.body.harperUser, null);
		});

		test('an untagged fault in a Bearer validator fails closed in place with the generic message', async () => {
			const response = await get(APP_ROUTE, 'Bearer ext-faulting-bearer');

			equal(response.status, 401, `an internal validator fault must fail closed in place: ${response.text}`);
			ok(response.body?.servedBy !== 'application-catch-all', 'an internal fault must not reach the application');
			ok(
				!/oidc jwks endpoint unreachable/.test(response.text),
				`the internal validator fault message must not leak to the client: ${response.text}`
			);
		});

		test('a Harper-minted operation token still authenticates when Bearer validators are registered', async () => {
			const tokenRes = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': adminAuthorization, 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'create_authentication_tokens' }),
			});
			equal(tokenRes.status, 200);
			const tokens = (await tokenRes.json()) as { operation_token?: string };
			const opToken = tokens?.operation_token;
			ok(typeof opToken === 'string' && opToken.length > 0, 'expected a minted operation_token');

			const protectedResponse = await get(PROTECTED_ROUTE, `Bearer ${opToken}`);
			equal(
				protectedResponse.status,
				200,
				`expected Harper operation token to read ${PROTECTED_ROUTE}: ${protectedResponse.text}`
			);

			const appResponse = await get(APP_ROUTE, `Bearer ${opToken}`);
			equal(appResponse.status, 200);
			equal(appResponse.body.harperUser, 'admin');
		});

		test('a Bearer token claimed by a registered validator is rejected on the Operations API both cold and after warming authorizationCache', async () => {
			const coldOpsRes = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: {
					'Authorization': 'Bearer ext-chain-bearer',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			equal(
				coldOpsRes.status,
				401,
				`Operations API must reject a validator-claimed Bearer token on a cold cache: ${await coldOpsRes.text()}`
			);

			const warmAppRes = await get(PROTECTED_ROUTE, 'Bearer ext-chain-bearer');
			equal(warmAppRes.status, 200);

			const warmOpsRes = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: {
					'Authorization': 'Bearer ext-chain-bearer',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			equal(
				warmOpsRes.status,
				401,
				`Operations API must reject a validator-claimed Bearer token even when cached in authorizationCache: ${await warmOpsRes.text()}`
			);
		});
	}
);
