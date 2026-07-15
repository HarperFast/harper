/**
 * #1786 review (heskew) — QUERY's body must not be able to disable the row-level `allowRead`
 * guard.
 *
 * `Resource.query` threads `checkPermission` from the framework-controlled URL `query` onto the
 * client-controlled request `data` (the QUERY body) so `Table.search` sees the flag and enforces
 * the record-scoped `allowRead` override (#1422 gap 2). Before the fix, that thread-through only
 * filled `data.checkPermission` when it was nullish — a client sending `checkPermission: false`
 * in the QUERY body survived untouched and disabled the row-level guard entirely, returning the
 * full unfiltered set.
 *
 * Fixture: reuses the `Vault` table from `subscription-row-allowread` (owner-scoped allowRead,
 * composes the base RBAC grant via `super.allowRead`).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/query-row-allowread-checkpermission.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-row-allowread');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ALICE = { username: 'query_allowread_alice', password: 'Alice-pw-1786!' };
const BOB = { username: 'query_allowread_bob', password: 'Bobby-pw-1786!' };
const ROLE = 'query_allowread_role';

const ALICE_ROWS = ['qrow-a1', 'qrow-a2'];
const BOB_ROWS = ['qrow-b1', 'qrow-b2'];

/**
 * Issue an HTTP QUERY request via fetch — supertest/superagent has no API for non-standard
 * verbs, while undici's fetch passes custom method tokens through.
 */
async function queryVault(restURL: string, headers: Record<string, string>, body: any): Promise<any[]> {
	const resp = await fetch(`${restURL}/Vault/`, {
		method: 'QUERY',
		headers: { ...headers, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	ok(resp.status === 200, `QUERY /Vault/ returned ${resp.status}: ${text}`);
	const data = JSON.parse(text);
	return Array.isArray(data) ? data : [];
}

suite(
	'#1786 QUERY body checkPermission cannot bypass row-level allowRead',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL = '';
		let aliceHeaders: Record<string, string>;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Vault/').timeout(3000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await new Promise((r) => setTimeout(r, 250));
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

			const records = [
				...ALICE_ROWS.map((id) => ({ id, owner: ALICE.username, secret: `alice-secret-${id}` })),
				...BOB_ROWS.map((id) => ({ id, owner: BOB.username, secret: `bob-secret-${id}` })),
			];
			await client.req().send({ operation: 'insert', schema: 'data', table: 'Vault', records }).expect(200);

			aliceHeaders = createHeaders(ALICE.username, ALICE.password);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('CONTROL: a plain QUERY only returns the requesting user’s own rows', async () => {
			const results = await queryVault(restURL, aliceHeaders, {});
			const ids = results.map((r: any) => r.id).sort();
			deepStrictEqual(ids, [...ALICE_ROWS].sort(), 'row-level allowRead should scope a QUERY to the caller’s own rows');
		});

		test('BYPASS ATTEMPT: checkPermission: false in the QUERY body must not disable the guard', async () => {
			const results = await queryVault(restURL, aliceHeaders, { checkPermission: false });
			const ids = results.map((r: any) => r.id).sort();
			ok(
				!BOB_ROWS.some((id) => ids.includes(id)),
				`QUERY-VERB BYPASS (#1786): client-supplied checkPermission:false leaked Bob's rows: ${JSON.stringify(ids)}`
			);
			deepStrictEqual(
				ids,
				[...ALICE_ROWS].sort(),
				'a client-supplied checkPermission:false must not widen the QUERY result beyond the caller’s own rows'
			);
		});
	}
);
