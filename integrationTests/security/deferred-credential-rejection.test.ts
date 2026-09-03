import { suite, test, before, after } from 'node:test';
import { equal, ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/deferred-credential-rejection');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const WORDPRESS_BASIC = `Basic ${Buffer.from('wordpress:abcd efgh ijkl mnop qrst uvwx').toString('base64')}`;
const DOWNSTREAM_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.d29vLXNlc3Npb24.not-a-harper-token';

const APP_ROUTE = '/wp-json/wc/v3/products';
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
			equal(unowned.body.harperUser, ctx.harper.admin.username);
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
	}
);
