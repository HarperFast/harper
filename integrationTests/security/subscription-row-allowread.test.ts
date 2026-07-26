/**
 * Explicit row filters must apply consistently to direct reads and subscription delivery.
 *
 * Fixture: a `Vault` table whose operation overrides perform admission and attach a `rowFilter`
 * that permits rows owned by the current user (see fixtures/subscription-row-allowread).
 * Alice and Bob are non-admin users owning different rows.
 *
 *   CONTROL  — Alice's REST GET of Bob's row is denied (proves allowRead is real and the
 *              AUTHENTICATION_AUTHORIZELOCAL loopback escape is not in play — real bearer auth).
 *   PROBE    — Alice opens a whole-table `/Vault/` SSE subscription. Writes land on Alice's
 *              rows, Bob's rows, and a neutral row. Alice's stream must receive ONLY her own
 *              rows' events; Bob's and the neutral row's events must be filtered out.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/subscription-row-allowread.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-row-allowread');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ALICE = { username: 'sub_allowread_alice', password: 'Alice-pw-1419!' };
const BOB = { username: 'sub_allowread_bob', password: 'Bobby-pw-1419!' };
const CAROL = { username: 'sub_allowread_carol', password: 'Carol-pw-1419!' }; // revocation subject (#1414 × override)
const ROLE = 'sub_allowread_role';
const ROLE_CAROL = 'sub_allowread_role_carol'; // dedicated so alter_role can strip read without touching ALICE/BOB
const CAROL_ROW = 'row-c1';

const ALICE_ROWS = ['row-a1', 'row-a2', 'row-a3'];
const BOB_ROWS = ['row-b1', 'row-b2', 'row-b3'];
const NEUTRAL_ROW = 'row-neutral';

// ---------------------------------------------------------------- SSE helpers --
interface SseEvent {
	data?: string;
	id?: string;
}
interface SseStream {
	events: SseEvent[];
	status: number;
	destroy: () => void;
}

function openSse(urlStr: string, headers: Record<string, string>): Promise<SseStream> {
	const url = new URL(urlStr);
	const lib = url.protocol === 'https:' ? https : http;
	const events: SseEvent[] = [];
	let buffer = '';
	const parseFrame = (frame: string) => {
		if (!frame.trim()) return;
		const ev: SseEvent = {};
		for (const line of frame.split('\n')) {
			const idx = line.indexOf(':');
			if (idx < 0) continue;
			const field = line.slice(0, idx);
			const val = line.slice(idx + 1).replace(/^ /, '');
			if (field === 'data') ev.data = (ev.data ? ev.data + '\n' : '') + val;
			else if (field === 'id') ev.id = val;
		}
		events.push(ev);
	};
	return new Promise<SseStream>((resolvePromise, reject) => {
		const req = lib.request(
			url,
			{ method: 'GET', headers: { ...headers, Accept: 'text/event-stream' }, rejectUnauthorized: false } as any,
			(res) => {
				const stream: SseStream = {
					events,
					status: res.statusCode ?? 0,
					destroy: () => {
						res.destroy();
						req.destroy();
					},
				};
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					buffer += chunk;
					let sep: number;
					while ((sep = buffer.indexOf('\n\n')) >= 0) {
						parseFrame(buffer.slice(0, sep));
						buffer = buffer.slice(sep + 2);
					}
				});
				res.on('error', () => {});
				resolvePromise(stream);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

function streamMentions(stream: SseStream, text: string): boolean {
	return stream.events.some((e) => (e.data ?? '').includes(text));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return predicate();
}

suite('explicit rowFilter filters subscription delivery', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL = '';
	let aliceBearer = '';

	const openStreams = new Set<SseStream>();

	const adminPut = (id: string, body: object) => request(restURL).put(`/Vault/${id}`).set(client.headers).send(body);
	const adminPutEventually = async (id: string, body: object) => {
		const deadline = Date.now() + 8000;
		let response = await adminPut(id, body);
		while (response.status === 404 && Date.now() < deadline) {
			await sleep(100);
			response = await adminPut(id, body);
		}
		ok(response.status === 204, `PUT /Vault/${id} failed with ${response.status}: ${response.text}`);
	};

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;

		// Poll until the Vault route is ready.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Vault/').timeout(3000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}

		// Non-super role with table-level READ/WRITE; application operation overrides add ownership.
		await client
			.req()
			.send({
				operation: 'add_role',
				role: ROLE,
				permission: {
					super_user: false,
					data: {
						tables: {
							Vault: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
						},
					},
				},
			})
			.expect(200);

		await client
			.req()
			.send({
				operation: 'add_role',
				role: ROLE_CAROL,
				permission: {
					super_user: false,
					data: {
						tables: {
							Vault: { read: true, insert: true, update: true, delete: true, attribute_permissions: [] },
						},
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
		await client
			.req()
			.send({
				operation: 'add_user',
				role: ROLE_CAROL,
				username: CAROL.username,
				password: CAROL.password,
				active: true,
			})
			.expect(200);

		// Seed rows via the ops API (super, bypasses allowCreate).
		const records = [
			...ALICE_ROWS.map((id) => ({ id, owner: ALICE.username, secret: `alice-secret-${id}` })),
			...BOB_ROWS.map((id) => ({ id, owner: BOB.username, secret: `bob-secret-${id}` })),
			{ id: CAROL_ROW, owner: CAROL.username, secret: 'carol-secret' },
			{ id: NEUTRAL_ROW, owner: 'nobody', secret: 'neutral-secret' },
		];
		await client.req().send({ operation: 'insert', schema: 'data', table: 'Vault', records }).expect(200);

		// Obtain Alice's bearer token so the SSE Authorization header uses real auth (not the
		// header-less AUTHORIZELOCAL loopback escape).
		const tokenResp = await client
			.req()
			.send({ operation: 'create_authentication_tokens', username: ALICE.username, password: ALICE.password });
		aliceBearer =
			tokenResp.status === 200 && tokenResp.body?.operation_token
				? `Bearer ${tokenResp.body.operation_token}`
				: createHeaders(ALICE.username, ALICE.password).Authorization;
	});

	after(async () => {
		for (const s of openStreams) {
			try {
				s.destroy();
			} catch {
				/* ignore */
			}
		}
		openStreams.clear();
		await teardownHarper(ctx);
	});

	test('CONTROL: the operation override denies Bob row and allows Alice row', async () => {
		const ownGet = await request(restURL).get(`/Vault/${ALICE_ROWS[0]}`).set({ Authorization: aliceBearer });
		ok(ownGet.status === 200, `Alice must read her own row, got ${ownGet.status}: ${ownGet.text}`);

		const bobGet = await request(restURL).get(`/Vault/${BOB_ROWS[0]}`).set({ Authorization: aliceBearer });
		ok(
			[401, 403, 404].includes(bobGet.status),
			`Alice GET Bob row should be denied, got ${bobGet.status}: ${bobGet.text}`
		);

		// Wrong password must not auto-authorize (would indicate an AUTHORIZELOCAL escape).
		const badGet = await request(restURL)
			.get(`/Vault/${ALICE_ROWS[0]}`)
			.set(createHeaders(ALICE.username, 'wrong-pw-1419'));
		ok([401, 403].includes(badGet.status), `wrong password was accepted (status ${badGet.status})`);
	});

	test('PROBE: whole-table SSE delivers only Alice rows; Bob/neutral events are filtered', async () => {
		const stream = await openSse(`${restURL}/Vault/`, { Authorization: aliceBearer });
		openStreams.add(stream);

		ok(stream.status >= 200 && stream.status < 300, `Alice's collection SSE should open, got ${stream.status}`);

		await sleep(400); // let the subscription attach

		for (const id of ALICE_ROWS) {
			await adminPut(id, { id, owner: ALICE.username, secret: `alice-secret-${id}`, updated: true }).expect(204);
		}
		for (const id of BOB_ROWS) {
			await adminPut(id, { id, owner: BOB.username, secret: `bob-secret-${id}`, updated: true }).expect(204);
		}
		await adminPut(NEUTRAL_ROW, { id: NEUTRAL_ROW, owner: 'nobody', secret: 'neutral-secret', updated: true }).expect(
			204
		);

		// Positive control: at least one of Alice's events must arrive.
		const gotAlice = await waitFor(() => ALICE_ROWS.some((id) => streamMentions(stream, id)), 8000);

		// Give denied rows equal opportunity to leak.
		await sleep(1500);

		const bobLeak =
			BOB_ROWS.some((id) => streamMentions(stream, id)) ||
			streamMentions(stream, BOB.username) ||
			streamMentions(stream, 'bob-secret');
		const neutralLeak =
			streamMentions(stream, NEUTRAL_ROW) ||
			streamMentions(stream, 'neutral-secret') ||
			streamMentions(stream, 'nobody');

		ok(
			gotAlice,
			'POSITIVE CONTROL FAILED: Alice did not receive updates to her own rows on the collection subscription'
		);
		ok(!bobLeak, "ROW-LEVEL LEAK (#1419): Bob's row events arrived on Alice's collection subscription stream");
		ok(
			!neutralLeak,
			"ROW-LEVEL LEAK (#1419): the neutral row's events arrived on Alice's collection subscription stream"
		);
	});

	test('REVOCATION (#1414): alter_role removing read terminates a filtered subscription', async () => {
		// Reauthorization reruns the operation-level table/RBAC allowRead grant against the fresh user.
		// alter_role (not drop_user) keeps the user present, so revoking table read must tear down the
		// subscription through that same one-shot gate.
		const carolToken = await client
			.req()
			.send({ operation: 'create_authentication_tokens', username: CAROL.username, password: CAROL.password });
		const carolBearer = `Bearer ${carolToken.body.operation_token}`;

		const stream = await openSse(`${restURL}/Vault/`, { Authorization: carolBearer });
		openStreams.add(stream);
		ok(stream.status >= 200 && stream.status < 300, `Carol's collection SSE should open, got ${stream.status}`);
		await sleep(400);

		// Baseline: Carol receives updates to her own row.
		await adminPut(CAROL_ROW, { id: CAROL_ROW, owner: CAROL.username, secret: 'carol-secret', v: 1 }).expect(204);
		ok(await waitFor(() => streamMentions(stream, CAROL_ROW), 8000), 'Carol should receive her own row event');

		// Strip read from Carol's role in place; the user still exists, so only the default table grant
		// (via the re-auth fallback) can terminate the stream.
		await client
			.req()
			.send({
				operation: 'alter_role',
				id: ROLE_CAROL,
				permission: {
					super_user: false,
					data: {
						tables: {
							Vault: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			})
			.expect(200);
		await sleep(2000); // let the user-change broadcast / re-auth land under CI load

		const eventsAfterRevoke = stream.events.length;
		await adminPutEventually(CAROL_ROW, {
			id: CAROL_ROW,
			owner: CAROL.username,
			secret: 'carol-secret',
			v: 2,
		});
		await sleep(1500);

		ok(
			stream.events.length === eventsAfterRevoke,
			`role lost read but subscription kept receiving ${stream.events.length - eventsAfterRevoke} event(s)`
		);
	});
});
