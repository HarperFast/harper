/**
 * Fail-closed enforcement when an allow* hook throws/rejects (HarperFast/harper#1422, gap 1).
 *
 * `allowRead` (and its allowCreate/allowUpdate/allowDelete siblings) is a grant hook layered
 * over RBAC. Historically a hook that threw synchronously had its exception swallowed upstream
 * and the request proceeded as authorized (fail open); an async hook that rejected had no
 * rejection handler on the transactional path and behaved the same way.
 *
 * These tests assert that a throwing/rejecting hook now fails closed — denied, not granted —
 * on both the single-record point-read and the collection-scan path, while a hook that grants
 * (and the super_user bypass) keep working.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';

import request from 'supertest';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/allowread-fail-closed');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ALICE = { username: 'failclosed_alice', password: 'Alice-pw-1422!' };
const ROLE = 'failclosed_role';

const IDS = ['row-00', 'row-01', 'row-02'];
const TABLES = ['Allowed', 'Throws', 'ThrowsAsync'];

suite('Fail-closed when allow* throws/rejects (#1422 gap 1)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL = '';
	let aliceHeaders: Record<string, string>;

	before(async () => {
		// AUTHORIZELOCAL=false so headerless loopback requests are not auto-authorized as super_user,
		// and Alice's Basic-auth goes through real authentication.
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' } });
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		aliceHeaders = createHeaders(ALICE.username, ALICE.password);

		// Wait for the routes to be ready.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Allowed/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await new Promise((r) => setTimeout(r, 200));
		}

		await client
			.req()
			.send({
				operation: 'add_role',
				role: ROLE,
				permission: {
					super_user: false,
					data: {
						tables: Object.fromEntries(
							TABLES.map((t) => [
								t,
								{ read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
							])
						),
					},
				},
			})
			.expect(200);

		await client
			.req()
			.send({ operation: 'add_user', role: ROLE, username: ALICE.username, password: ALICE.password, active: true })
			.expect(200);

		const records = IDS.map((id, i) => ({ id, value: `v-${i}` }));
		for (const table of TABLES) {
			const resp = await client.req().send({ operation: 'insert', schema: 'data', table, records });
			ok(resp.status === 200, `Seed ${table} failed: ${resp.status} ${resp.text}`);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('HAPPY PATH: a granting allowRead still authorizes — point-read and collection both 200', async () => {
		const pointRead = await request(restURL).get(`/Allowed/${IDS[0]}`).set(aliceHeaders);
		strictEqual(
			pointRead.status,
			200,
			`granting allowRead must allow point-read: ${pointRead.status} ${pointRead.text}`
		);

		const collection = await request(restURL).get('/Allowed/?id=ge=row-00&sort(id)').set(aliceHeaders);
		strictEqual(
			collection.status,
			200,
			`granting allowRead must allow collection: ${collection.status} ${collection.text}`
		);
		const rows: any[] = Array.isArray(collection.body) ? collection.body : [];
		strictEqual(rows.length, IDS.length, `granting allowRead should return all ${IDS.length} rows, saw ${rows.length}`);
	});

	test('SYNC THROW: allowRead that throws fails closed — point-read denied, not granted', async () => {
		const resp = await request(restURL).get(`/Throws/${IDS[0]}`).set(aliceHeaders);
		ok(
			[401, 403].includes(resp.status),
			`thrown allowRead must fail closed on point-read, got ${resp.status} ${resp.text}`
		);
	});

	test('SYNC THROW: allowRead that throws fails closed — collection scan denied or empty', async () => {
		const resp = await request(restURL).get('/Throws/?id=ge=row-00&sort(id)').set(aliceHeaders);
		if (resp.status === 200) {
			const rows: any[] = Array.isArray(resp.body) ? resp.body : [];
			strictEqual(rows.length, 0, `thrown allowRead leaked ${rows.length} rows on collection scan`);
		} else {
			ok(
				[401, 403].includes(resp.status),
				`thrown allowRead must fail closed on collection scan, got ${resp.status} ${resp.text}`
			);
		}
	});

	test('ASYNC REJECT: allowRead that rejects fails closed — point-read denied, not granted', async () => {
		const resp = await request(restURL).get(`/ThrowsAsync/${IDS[0]}`).set(aliceHeaders);
		ok(
			[401, 403].includes(resp.status),
			`rejected async allowRead must fail closed on point-read, got ${resp.status} ${resp.text}`
		);
	});

	test('ASYNC REJECT: allowRead that rejects fails closed — collection scan denied or empty', async () => {
		const resp = await request(restURL).get('/ThrowsAsync/?id=ge=row-00&sort(id)').set(aliceHeaders);
		if (resp.status === 200) {
			const rows: any[] = Array.isArray(resp.body) ? resp.body : [];
			strictEqual(rows.length, 0, `rejected async allowRead leaked ${rows.length} rows on collection scan`);
		} else {
			ok(
				[401, 403].includes(resp.status),
				`rejected async allowRead must fail closed on collection scan, got ${resp.status} ${resp.text}`
			);
		}
	});

	test('SUPER USER: bypasses the throwing hook — reads every row', async () => {
		const resp = await client.reqRest('/Throws/?id=ge=row-00&sort(id)');
		strictEqual(resp.status, 200, `super user collection GET failed: ${resp.status} ${resp.text}`);
		const rows: any[] = Array.isArray(resp.body) ? resp.body : [];
		strictEqual(rows.length, IDS.length, `super user should see all ${IDS.length} rows, saw ${rows.length}`);
	});
});
