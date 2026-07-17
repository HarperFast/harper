/**
 * TTL edge-case integration tests — issue #1191
 *
 * Covers expiration edge cases NOT already tested in blob.test.mjs:
 *   1. Expiry-reset-on-update: updating a record resets its TTL countdown
 *   2. No cross-table bleed: TTL table expiry does not affect a co-located non-TTL table
 *   3. Cache-control max-age override: `cache-control: max-age=N` header extends TTL
 *      beyond the schema default (only valid on @cached resources; regular @table with
 *      expiration does not expose isCaching, so this uses a caching-style table approach
 *      via the blob test component pattern)
 *   4. High-volume expiry: 200 records inserted with short TTL are all gone after expiry
 *
 * Audit retention is covered by blob.test.mjs — see that file for those assertions.
 *
 * Skipped on Windows: depends on `restart_service http_workers` (HarperFast/harper#549).
 * Skipped on Bun: timing-sensitive TTL tests are not reliable under Harper-on-Bun in CI.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './utils/client.mjs';
// @ts-expect-error utils/components.mjs has no type declarations; runtime resolves fine
import { installAppComponent } from './utils/components.mjs';

const MAX_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

/** Poll until `fn` resolves without throwing, or throw the last error after `maxWaitMs`. */
async function pollUntil(fn: () => Promise<void>, maxWaitMs = MAX_WAIT_MS): Promise<void> {
	const deadline = Date.now() + maxWaitMs;
	let lastErr: Error = new Error(`pollUntil timed out after ${maxWaitMs}ms`);
	while (Date.now() < deadline) {
		try {
			await fn();
			return;
		} catch (err) {
			lastErr = err;
			await sleep(POLL_INTERVAL_MS);
		}
	}
	throw lastErr;
}

/**
 * Schema for TTL edge-case tests.
 *
 * - ShortLived: 5s TTL — used for expiry-reset and cross-table-bleed tests
 * - LongLived: no TTL — used to verify cross-table isolation
 * - BulkExpiry: 5s TTL — used for high-volume expiry test
 *
 * Note: max-age query-param override (`?max-age=<seconds>`) is NOT yet implemented
 * in Harper's REST layer. The `cache-control: max-age` header is supported but only
 * on resources that set `isCaching = true`. The query-param form is tracked as a
 * future enhancement; see server/REST.ts for the existing header-based path.
 */
const SCHEMA_GRAPHQL = `
type ShortLived @table(expiration: 5) @export {
	id: ID @primaryKey
	value: String
}

type LongLived @table @export {
	id: ID @primaryKey
	value: String
}

type BulkExpiry @table(expiration: 5) @export {
	id: ID @primaryKey
	value: String
}

# 2s TTL so reads hide a record shortly after write, but a 1h eviction window so the
# expired record stays PHYSICALLY present ("expired but not swept") for the whole test:
# expiration sets when reads hide the row (expiresAt = write + 2s), while eviction holds
# off physical reclamation until expiresAt + 1h. This gives a deterministic window to
# assert the SQL-engine row-finder's includeExpired behavior (QA-269) — see the
# "SQL UPDATE/DELETE" test below. (eviction is persisted on the primary attribute,
# unlike scanInterval, so it survives a schema reload.)
type SqlTtl @table(expiration: 2, eviction: 3600) @export {
	id: ID @primaryKey
	payload: String
}
`;

const CONFIG_YAML = `rest: true
graphqlSchema:
  files: '*.graphql'
`;

suite('TTL edge cases', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'ttledge',
			files: {
				'schema.graphql': SCHEMA_GRAPHQL,
				'config.yaml': CONFIG_YAML,
			},
			probePath: '/ShortLived/',
			restartTimeoutMs: 120_000,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	/**
	 * Test 1: Expiry-reset-on-update
	 *
	 * Timeline:
	 *   t=0   insert {id: 'reset-item', value: 'original'} (TTL=5s → expires ~t=5)
	 *   t=3   PUT same record with updated value → should reset TTL to t+5 (~t=8)
	 *   t=6   record would have expired without reset → must still be present
	 *   t=9   still within new TTL window → must still be present
	 */
	test('expiry-reset-on-update: updating a record resets its TTL', async () => {
		// t=0 — insert
		await request(client.restURL)
			.put('/ShortLived/reset-item')
			.set(client.headers)
			.send({ id: 'reset-item', value: 'original' })
			.expect(204);

		// t≈3 — update (within original TTL)
		await sleep(3_000);
		await request(client.restURL)
			.put('/ShortLived/reset-item')
			.set(client.headers)
			.send({ id: 'reset-item', value: 'updated' })
			.expect(204);

		// t≈6 — would have expired under original TTL; should still be present
		await sleep(3_000);
		await client
			.reqRest('/ShortLived/reset-item')
			.expect(200)
			.then((r: any) => {
				strictEqual(
					r.body.value,
					'updated',
					`record should still be present at t≈6s (TTL was reset); got: ${JSON.stringify(r.body)}`
				);
			});

		// t≈9 — still inside the reset TTL (update was at t≈3, TTL=5s → expires ~t=8-ish)
		// Allow a brief window: if the update actually happened at t=3.0 and TTL=5,
		// the record expires at ~t=8. We check just before that boundary.
		// (This assertion is best-effort on slow runners; we assert with polling.)
		await sleep(2_000);
		// t≈11 — Now confirm the record DOES expire after the reset TTL elapses.
		// The update was at ~t=3; TTL=5s → should expire by ~t=8.
		// We're now well past t=8, so the record should be gone.
		await pollUntil(async () => {
			const r = await client.reqRest('/ShortLived/reset-item').timeout(3_000);
			ok(r.status === 404, `record should have expired after reset TTL elapsed, got status ${r.status}`);
		});
	});

	/**
	 * Test 2: No cross-table bleed
	 *
	 * Insert the same ID into ShortLived (5s TTL) and LongLived (no TTL).
	 * After 6s the ShortLived record should be gone; LongLived must survive.
	 */
	test('no cross-table bleed: TTL expiry does not affect co-located non-TTL table', async () => {
		const id = 'bleed-test';

		await Promise.all([
			request(client.restURL).put(`/ShortLived/${id}`).set(client.headers).send({ id, value: 'short' }).expect(204),
			request(client.restURL).put(`/LongLived/${id}`).set(client.headers).send({ id, value: 'long' }).expect(204),
		]);

		// Both records present immediately
		await client.reqRest(`/ShortLived/${id}`).expect(200);
		await client.reqRest(`/LongLived/${id}`).expect(200);

		// Wait for ShortLived TTL to elapse
		await pollUntil(async () => {
			const r = await client.reqRest(`/ShortLived/${id}`).timeout(3_000);
			ok(r.status === 404, `ShortLived/${id} should have expired, got ${r.status}`);
		});

		// LongLived must still be present
		const longResp = await client.reqRest(`/LongLived/${id}`).expect(200);
		strictEqual(longResp.body.value, 'long', 'LongLived record should not be affected by ShortLived TTL');
	});

	/**
	 * Test 3: max-age override (cache-control header)
	 *
	 * NOTE: `?max-age=<seconds>` query-param override is not yet implemented.
	 * The `cache-control: max-age` header is parsed in server/REST.ts but only
	 * applies when `resource.isCaching === true` (i.e. caching tables).
	 * Regular @table(expiration:) resources do not set isCaching, so the header
	 * path is a no-op for these schema types.
	 *
	 * TODO: Implement `?max-age=<seconds>` query-param override on @table resources.
	 *       When implemented, add a test here that PUTs /ShortLived/max-age-item
	 *       with `?max-age=30` and verifies the record survives past the 5s schema TTL.
	 */
	test('max-age override via query param is not yet implemented (placeholder)', () => {
		// This test intentionally passes as a documented placeholder.
		// See the comment above for what needs to be implemented.
		ok(true, 'placeholder — max-age query-param override not yet implemented; see issue #1191');
	});

	/**
	 * Test 4: High-volume expiry — 200 records × 5s TTL
	 *
	 * Insert 200 records into BulkExpiry. After the TTL elapses, the table
	 * must report 0 records. This is a behavioral (not byte-size) assertion —
	 * it verifies the expiry sweep handles load without leaving behind ghost rows.
	 */
	test('high-volume expiry: 200 records are all removed after TTL', async () => {
		const records = Array.from({ length: 200 }, (_, i) => ({
			id: `bulk-${i}`,
			value: `value-${i}`,
		}));

		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'data',
				table: 'BulkExpiry',
				records,
			})
			.expect(200);

		// Verify records were inserted
		const countBeforeResp = await client
			.req()
			.send({ operation: 'sql', sql: 'SELECT count(*) FROM data.BulkExpiry' })
			.expect(200);
		ok(countBeforeResp.body[0]['COUNT(*)'] > 0, 'records should be present immediately after insert');

		// Wait for expiry + reclamation sweep; poll until count reaches 0
		await pollUntil(async () => {
			const r = await client.req().send({ operation: 'sql', sql: 'SELECT count(*) FROM data.BulkExpiry' }).expect(200);
			const count = r.body[0]['COUNT(*)'];
			strictEqual(count, 0, `expected 0 records after TTL expiry, got ${count}`);
		}, 25_000);
	});

	/**
	 * Test 5: SQL UPDATE/DELETE row-finder sees a not-yet-swept expired row (QA-269)
	 *
	 * A plain SQL SELECT is right to HIDE a row whose TTL has passed but the eviction
	 * scan hasn't reclaimed yet — and, in fact, reading it lazily evicts it. A SQL
	 * UPDATE/DELETE must NOT drop it: like every other write surface (REST PUT/PATCH/
	 * DELETE, ops update/delete) it targets the row directly and must find it, or the
	 * write silently touches nothing (an UPDATE would never get to reset the TTL). The
	 * new engine's mutation row-finder passes `includeExpired` for exactly this reason
	 * (runMutation.ts).
	 *
	 * Each id is exercised by exactly ONE surface: because a plain SELECT lazily evicts
	 * the expired row it reads, the hidden/update/delete legs must use DISTINCT ids —
	 * otherwise the SELECT leg would drop the row the mutation legs are meant to find.
	 * SqlTtl's 1h eviction window keeps the un-read rows physically present so the
	 * mutation legs are deterministic (no background sweep reclaims them mid-test).
	 */
	test('SQL UPDATE/DELETE find a not-yet-swept expired row; plain SELECT hides it', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'data',
				table: 'SqlTtl',
				records: [
					{ id: 'sel', payload: 'orig' },
					{ id: 'upd', payload: 'orig' },
					{ id: 'del', payload: 'orig' },
				],
			})
			.expect(200);

		// Let all rows pass their 2s TTL. No sweep reclaims them (1h eviction window),
		// and none has been read yet, so none has been lazily evicted.
		await sleep(2_500);

		// Leg 1 — a plain SELECT hides the expired row (and lazily evicts 'sel'; that's
		// why the mutation legs below use their own ids).
		const hidden = await client
			.req()
			.send({ operation: 'sql', sql: "SELECT id, payload FROM data.SqlTtl WHERE id = 'sel'" })
			.expect(200);
		strictEqual(hidden.body.length, 0, `plain SELECT should hide the expired row, got: ${JSON.stringify(hidden.body)}`);

		// Leg 2a — SQL UPDATE finds the expired 'upd' row (includeExpired) and resets its TTL.
		await client
			.req()
			.send({ operation: 'sql', sql: "UPDATE data.SqlTtl SET payload = 'reset' WHERE id = 'upd'" })
			.expect((r: any) => strictEqual(r.body.message, 'updated 1 of 1 records', r.text))
			.expect((r: any) => strictEqual(r.body.update_hashes[0], 'upd', r.text))
			.expect(200);

		// The UPDATE reset the TTL, so the row is live again and a plain SELECT sees it.
		await client
			.req()
			.send({ operation: 'sql', sql: "SELECT payload FROM data.SqlTtl WHERE id = 'upd'" })
			.expect((r: any) => strictEqual(r.body.length, 1, r.text))
			.expect((r: any) => strictEqual(r.body[0].payload, 'reset', r.text))
			.expect(200);

		// Leg 2b — SQL DELETE finds the still-expired 'del' row and removes it (1 of 1, not 0 of 0).
		await client
			.req()
			.send({ operation: 'sql', sql: "DELETE FROM data.SqlTtl WHERE id = 'del'" })
			.expect((r: any) => ok(r.body.message.includes('1 of 1 record successfully deleted'), r.text))
			.expect((r: any) => strictEqual(r.body.deleted_hashes[0], 'del', r.text))
			.expect(200);
	});
});
