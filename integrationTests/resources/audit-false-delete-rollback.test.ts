/**
 * F-147 / #1854 — aborted delete on an audit:false @indexed table must roll back cleanly.
 *
 * `_writeDelete()`'s non-audit branch (resources/Table.ts, inside
 * `transaction.addWrite({ commit: (txnTime, existingEntry, retry, transaction) => {...} })`)
 * used to call `removeEntry(primaryStore, existingEntry)` without threading the enclosing
 * transaction in, unlike its two sibling branches (`updateIndices(..., transaction && {
 * transaction })` and `updateRecord(..., { transaction, ... })`). `removeEntry()` passes its
 * options straight to `store.remove(key, options)`, so with no `{transaction}` the removal
 * committed standalone against the raw store instead of joining the ambient transaction — an
 * aborted transaction still durably removed the row (and its blobs, and left the secondary
 * index dangling), because the removal never had a chance to roll back.
 *
 * `audit: false` is required to reach this branch: the `audit: true` path goes through
 * `updateRecord()`, which already threads `{transaction}` and rolls back correctly.
 *
 * P1: DELETE + throw (transaction abort) on an audit:false table — the row and its
 *     secondary-index entry must both survive (no dangling index entry, no data loss).
 * P2: DELETE without a throw (normal commit) — the row and index entry must both be gone
 *     (regression guard: the fix must not break an ordinary committed delete).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/resources/audit-false-delete-rollback.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-false-delete-rollback');
const skipSuite = process.platform === 'win32';
const ENGINE = process.env.HARPER_STORAGE_ENGINE || 'rocksdb(default)';

suite(
	`F-147/#1854 audit:false delete rollback atomicity [engine=${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let auth: string;

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify(body),
			});
		}

		async function restGet(path: string): Promise<{ status: number; body: any }> {
			const r = await fetch(`${httpURL}${path}`, { headers: { Authorization: auth } });
			let body: any = null;
			try {
				body = await r.json();
			} catch {
				/* ignore */
			}
			return { status: r.status, body };
		}

		/** Raw NoSQL ops helper — a separate request, so it reflects genuinely committed state. */
		async function op(payload: any): Promise<{ status: number; body: any }> {
			const r = await client.req().send(payload).timeout(20_000);
			return { status: r.status, body: r.body };
		}

		async function getItem(id: string): Promise<any | null> {
			const r = await restGet(`/Item/${id}`);
			return r.status === 200 ? r.body : null;
		}

		/** Count Items indexed under `bucket` via the raw secondary-index path (search_by_value). */
		async function bucketIndexCount(bucket: string): Promise<number> {
			const r = await op({
				operation: 'search_by_value',
				schema: 'data',
				table: 'Item',
				search_attribute: 'bucket',
				search_value: bucket,
				get_attributes: ['id'],
			});
			const rows: any[] = Array.isArray(r.body) ? r.body : [];
			return rows.length;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			auth = client.headers.Authorization;
			// Poll for route readiness (component is pre-installed; no restart needed)
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Item/').timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('P1 aborted delete: row and secondary-index entry both survive', async () => {
			const id = 'p1-abort';
			const bucket = 'p1-bucket';

			const putRes = await postJSON('/Item/', { id, bucket, payload: 'x' });
			ok(putRes.status < 300, `seed put must succeed; got ${putRes.status}`);

			const preItem = await getItem(id);
			ok(preItem, 'seeded Item must exist before the aborted delete');
			strictEqual(await bucketIndexCount(bucket), 1, 'seeded Item must be indexed before the aborted delete');

			const res = await postJSON('/DeleteAndAbort/', { id });
			await sleep(300); // give any (incorrect) async removal a moment to land

			const postItem = await getItem(id);
			const indexCount = await bucketIndexCount(bucket);

			console.log(
				`\n[F-147 P1 engine=${ENGINE}] throw status=${res.status} (expect 4xx/5xx)\n` +
					`  Item present after abort=${!!postItem} (expect true)\n` +
					`  bucket index count=${indexCount} (expect 1)\n` +
					`  >>> ${postItem && indexCount === 1 ? 'ATOMIC — delete rolled back, index intact' : 'DEFECT — delete escaped the aborted transaction'}`
			);

			ok(res.status >= 400, `throwing handler must not return 2xx; got ${res.status}`);
			ok(postItem, 'Item must still exist after the aborted delete (removal must roll back)');
			strictEqual(postItem?.bucket, bucket, 'surviving Item must retain its original bucket');
			strictEqual(indexCount, 1, `bucket index must still list the surviving Item; got count=${indexCount}`);
		});

		test('P2 committed delete: row and secondary-index entry are both removed', async () => {
			const id = 'p2-commit';
			const bucket = 'p2-bucket';

			const putRes = await postJSON('/Item/', { id, bucket, payload: 'x' });
			ok(putRes.status < 300, `seed put must succeed; got ${putRes.status}`);
			strictEqual(await bucketIndexCount(bucket), 1, 'seeded Item must be indexed before delete');

			const res = await postJSON('/DeleteAndCommit/', { id });
			strictEqual(res.status, 200, `DeleteAndCommit must succeed; got ${res.status}`);
			await sleep(300);

			const postItem = await getItem(id);
			const indexCount = await bucketIndexCount(bucket);

			ok(!postItem, 'Item must be gone after a normal (non-aborted) delete');
			strictEqual(indexCount, 0, `bucket index must have no entries after a committed delete; got count=${indexCount}`);
		});
	}
);
