/**
 * Continuous re-authorization for live subscriptions (HarperFast/harper#1414).
 *
 * Subscribe-time authorization is a point-in-time check — once an SSE/WS/MQTT stream is open it
 * keeps delivering even if the principal later loses access or its bearer token expires. These
 * tests open an SSE collection subscription and assert delivery STOPS after:
 *   1. the user's permission is revoked (drop_user) — event-driven via the user-change broadcast, and
 *   2. the bearer token the subscription was opened with expires — caught by the interval sweep.
 *
 * Re-authorization is table/RBAC-level (matching how the subscription was granted); there is no
 * per-record evaluation.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/subscription-revocation');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ROLE = 'subrevoke_role';
const ALICE = { username: 'subrevoke_alice', password: 'Alice-pw-1414!' };
const BOB = { username: 'subrevoke_bob', password: 'Bobby-pw-1414!' };

/** An open SSE stream that records how many record events have arrived. */
interface SseStream {
	count: () => number;
	ended: () => boolean;
	status: () => number;
	close: () => void;
}

// Returns synchronously — Harper flushes SSE headers on the first delivered event, so we must not
// block on the response callback before producing a write. Handlers are attached when the response
// begins; the caller seeds writes after a short settle so the subscription is established first.
function openSse(restURL: string, path: string, headers: Record<string, string>): SseStream {
	const url = new URL(restURL);
	let events = 0;
	let ended = false;
	let status = 0;
	const req = httpRequest(
		{
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			method: 'GET',
			path,
			headers: { Accept: 'text/event-stream', ...headers },
		},
		(res) => {
			status = res.statusCode ?? 0;
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				// Count SSE data lines carrying a record payload (one per delivered event).
				for (const line of chunk.split('\n')) {
					if (line.startsWith('data:') && line.slice(5).trim().length > 0) events++;
				}
			});
			res.on('end', () => (ended = true));
			res.on('close', () => (ended = true));
		}
	);
	req.on('error', () => (ended = true));
	req.end();
	return { count: () => events, ended: () => ended, status: () => status, close: () => req.destroy() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('Live subscription re-authorization (#1414)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL = '';
	let seq = 0;

	const insert = (record: Record<string, unknown>) =>
		client
			.req()
			.send({ operation: 'insert', schema: 'data', table: 'Owned', records: [record] })
			.expect(200);

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {},
			env: {
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
				// Sweep often so the token-expiry path (not event-signaled) is observable in-test.
				HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS: '1000',
			},
		});
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;

		// Wait for the route.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Owned/').timeout(3_000);
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
						tables: { Owned: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
					},
				},
			})
			.expect(200);
		for (const u of [ALICE, BOB]) {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: u.username, password: u.password, active: true })
				.expect(200);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('permission loss (drop_user) terminates an active subscription', async () => {
		const headers = { Authorization: 'Basic ' + Buffer.from(`${ALICE.username}:${ALICE.password}`).toString('base64') };
		const stream = openSse(restURL, '/Owned/', headers);
		try {
			await sleep(800); // let the subscription establish
			// Baseline: a write while authorized is delivered.
			await insert({ id: `r-${seq++}`, value: 'before' });
			await sleep(1000);
			ok(stream.status() === 0 || stream.status() === 200, `unexpected SSE status ${stream.status()}`);
			const afterFirst = stream.count();
			ok(afterFirst >= 1, `expected delivery while authorized, saw ${afterFirst} events`);

			// Revoke access mid-stream. drop_user broadcasts a user-change → immediate re-auth sweep.
			await client.req().send({ operation: 'drop_user', username: ALICE.username }).expect(200);
			await sleep(2000);

			// A write after revocation must NOT be delivered.
			const beforeRevokeProbe = stream.count();
			await insert({ id: `r-${seq++}`, value: 'after-revoke' });
			await sleep(1500);
			strictEqual(
				stream.count(),
				beforeRevokeProbe,
				`subscription kept delivering after drop_user (got ${stream.count() - beforeRevokeProbe} extra events)`
			);
		} finally {
			stream.close();
		}
	});

	test('bearer token expiry terminates an active subscription', async () => {
		// Issue a short-lived operation token for Bob (independent of the dropped Alice).
		const tokenResp = await client.req().send({
			operation: 'create_authentication_tokens',
			username: BOB.username,
			password: BOB.password,
			expires_in: 3,
		});
		strictEqual(tokenResp.status, 200, `token issue failed: ${tokenResp.status} ${tokenResp.text}`);
		const token = tokenResp.body?.operation_token;
		ok(token, 'expected an operation_token');

		const stream = openSse(restURL, '/Owned/', { Authorization: `Bearer ${token}` });
		try {
			await sleep(800); // let the subscription establish
			await insert({ id: `r-${seq++}`, value: 'token-before' });
			await sleep(1000);
			ok(stream.count() >= 1, `expected delivery while token valid, saw ${stream.count()}`);

			// Wait past token expiry (3s) plus a sweep interval (1s).
			await sleep(4000);
			const probe = stream.count();
			await insert({ id: `r-${seq++}`, value: 'token-after' });
			await sleep(1500);
			strictEqual(
				stream.count(),
				probe,
				`subscription kept delivering after token expiry (${stream.count() - probe} extra)`
			);
		} finally {
			stream.close();
		}
	});
});
