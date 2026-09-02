/**
 * End-to-end proof that an app-port credential Harper does not recognize is not rejected until
 * route ownership is known.
 *
 * The chain under test is the real one — `authentication -> rest -> application catch-all` — served
 * by a real Harper instance.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/deferred-credential-rejection.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/deferred-credential-rejection');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

/** A WordPress Application Password, base64'd exactly as WordPress sends it — spaces and all. */
const WORDPRESS_BASIC = `Basic ${Buffer.from('wordpress:abcd efgh ijkl mnop qrst uvwx').toString('base64')}`;
/** A session token belonging to the downstream application, not to Harper. */
const DOWNSTREAM_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.d29vLXNlc3Npb24.not-a-harper-token';

/** A URL no Harper route owns — the shape WooCommerce's REST API uses. */
const APP_ROUTE = '/wp-json/wc/v3/products';
/** A Harper-owned resource that requires an authenticated principal. */
const PROTECTED_ROUTE = '/Ledger/';
/** A Harper-owned resource that an anonymous caller may read. */
const PUBLIC_ROUTE = '/PublicNotice/';

suite(
	'#2418 unrecognized app-port credentials defer until route ownership',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL = '';
		let adminAuthorization = '';

		/** Issues a raw request so the exact Authorization header under test reaches the wire unchanged. */
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
				config: {},
				env: {
					HARPER_BUILTIN_COMPONENTS:
						'deferredAuthAppCatchAll=@/integrationTests/security/fixtures/deferred-credential-rejection/appCatchAll.js',
				},
			});
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			adminAuthorization = client.headers.Authorization;

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
			// If the catch-all had been hoisted ahead of `rest`, it would claim this Harper-owned route
			// too — which is exactly the trade the issue refuses to make.
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
			// No rename, no carrier header, no stripping — the application gets what the client sent.
			equal(response.body.authorization, WORDPRESS_BASIC);
			// And Harper attached no principal on the way through.
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
			// Anonymous callers may read PublicNotice, so if a deferred credential simply became
			// "anonymous" this would return the record. Harper owns the route, so Harper decides it.
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
			// No Authorization header means no credential to defer, so Harper's own principal
			// resolution runs exactly as it did before: this harness starts Harper with
			// AUTHENTICATION_AUTHORIZELOCAL=true, and a loopback caller with no credentials is
			// therefore still the local super user. That untouched path is precisely why the
			// deferred-credential cases above assert `harperUser === null` — a rejected credential
			// must not reach this bypass and be answered as a privileged anonymous request.
			equal(unowned.body.harperUser, ctx.harper.admin.username);
		});

		test('a deferred-credential response is kept out of shared caches', async () => {
			// The application answered using the header Harper passed through, so the response varies by
			// credential even though no Harper principal was resolved (#1565's identity floor).
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
			// The wire contract every caller has seen for a rejected credential: `{error: message}` in
			// the request's negotiated serialization. REST's own error mapping renders a thrown error as
			// an RFC 9457 Problem Details document (`type`/`title`/`status`), which is NOT this, so a
			// settlement that went through REST's catch would silently change the response shape.
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
			// The contrast case: without a credential to reject, GraphQL's own handling is untouched.
			const response = await fetch(`${restURL}/graphql?query=%7B__typename%7D`, {
				headers: { Accept: 'application/json' },
			});

			ok(response.status !== 401, `an anonymous /graphql request must not be rejected: ${await response.text()}`);
		});

		test('the operations API still rejects an unrecognized credential in place', async () => {
			// Every operations route is Harper-owned, so there is nothing to defer to and nothing changes.
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': WORDPRESS_BASIC, 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
			});

			equal(response.status, 401);
		});
	}
);
