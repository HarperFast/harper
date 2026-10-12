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
 * P1: DELETE + throw (transaction abort) on an audit:false table — the row, its
 *     secondary-index entry, and its file-backed blob must all survive (no dangling index
 *     entry, no data loss, no orphaned blob file).
 * P2: DELETE without a throw (normal commit) — the row, index entry, and blob must all be
 *     gone (regression guard: the fix must not break an ordinary committed delete).
 *
 * The index-entry half of both checks reads the raw secondary-index store directly
 * (`index.getRange({ start: null })`, resources.js's `IndexDump`), never `search_by_value`:
 * `search_by_value` joins each hit back through its primary record (resources/Table.ts,
 * `if (record == null) return canSkip ? SKIP : record`) and silently drops any hit whose
 * record is gone — exactly the dangling/phantom shape this suite exists to catch, and exactly
 * what a committed delete that skipped the index cleanup would produce. A raw-index check must
 * also not be scoped to the expected bucket value alone: a regression that leaves a null-keyed
 * phantom (`[null, id]`, the F-175 shape in eviction-index-phantom-null-keys.test.ts) would
 * still pass a check scoped to `bucket=X`, so the oracle here asks "no entry under *any*
 * value", not "zero entries under the one value this test used". `Q0` below plants both a
 * real-valued and a null-keyed dangling entry (bypassing the record layer, like
 * table-clear-secondary-index.test.ts's Q0) to prove the raw read actually sees both shapes
 * before any of P1/P2's "0 entries" results are trusted.
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
// Above blob.ts's FILE_STORAGE_THRESHOLD (8192) so the blob attribute is file-backed —
// an inline blob has no file to orphan and wouldn't exercise removeEntry's blob-unlink gate.
const BLOB_SIZE = 8192 + 200;

interface IndexRow {
	indexedValue: unknown;
	primaryKey: string;
}

function blobText(id: string): string {
	return `${id}:`.repeat(Math.ceil(BLOB_SIZE / (id.length + 1))).slice(0, BLOB_SIZE);
}

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

		async function getItem(id: string): Promise<any | null> {
			const r = await restGet(`/Item/${id}`);
			return r.status === 200 ? r.body : null;
		}

		/** GET /Item/<id>.blob — dot-notation sub-attribute selects the raw blob bytes,
		 * independent of whether the record itself is otherwise reachable. */
		async function getBlob(id: string): Promise<{ status: number; text: string | null }> {
			const r = await fetch(`${httpURL}/Item/${encodeURIComponent(id)}.blob`, { headers: { Authorization: auth } });
			const text = r.status === 200 ? await r.text() : null;
			return { status: r.status, text };
		}

		/** Raw Item/bucket index dump (never joins through the primary record — see file header). */
		async function indexDump(): Promise<IndexRow[]> {
			const r = await fetch(`${httpURL}/IndexDump/?attr=bucket`, { headers: { Authorization: auth } });
			strictEqual(r.status, 200, `/IndexDump/ should return 200, got ${r.status}`);
			return r.json();
		}

		/** Raw index entries for `id`, under ANY indexed value — including a null-keyed phantom. */
		async function indexEntriesForId(id: string): Promise<IndexRow[]> {
			const idx = await indexDump();
			return idx.filter((e) => e.primaryKey === id);
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

		// ---- Q0: prove the raw oracle is NOT blind before trusting any "0 entries" result later ----
		test(
			'Q0 oracle self-proof: a planted real-valued AND null-keyed dangling entry are both visible',
			{ timeout: 15_000 },
			async () => {
				// Table is empty at this point. Write directly into the raw bucket index dbi with no
				// corresponding primary row -- the F-149 (real-valued) and F-175 (null-keyed) phantom
				// shapes this suite's P1/P2 assertions must both be able to detect.
				const plantReal = await postJSON('/PlantDangling/', { attr: 'bucket', value: 'GHOST', key: 'ghost-real' });
				strictEqual(plantReal.status, 200, `PlantDangling(real) should return 200, got ${plantReal.status}`);
				const plantNull = await postJSON('/PlantDangling/', { attr: 'bucket', value: null, key: 'ghost-null' });
				strictEqual(plantNull.status, 200, `PlantDangling(null) should return 200, got ${plantNull.status}`);

				const realEntries = await indexEntriesForId('ghost-real');
				const nullEntries = await indexEntriesForId('ghost-null');
				strictEqual(realEntries.length, 1, 'IndexDump must see the planted real-valued dangling entry');
				strictEqual(realEntries[0].indexedValue, 'GHOST', 'planted real-valued entry must report its value');
				strictEqual(nullEntries.length, 1, 'IndexDump must see the planted null-keyed dangling entry (F-175)');
				strictEqual(nullEntries[0].indexedValue, null, 'planted null-keyed entry must report indexedValue=null');

				// Clean up before P1/P2 seed their own ids, so no stray planted entry skews their counts.
				await postJSON('/RemoveIndexEntry/', { attr: 'bucket', value: 'GHOST', key: 'ghost-real' });
				await postJSON('/RemoveIndexEntry/', { attr: 'bucket', value: null, key: 'ghost-null' });
				ok((await indexEntriesForId('ghost-real')).length === 0, 'cleanup must remove the real-valued entry');
				ok((await indexEntriesForId('ghost-null')).length === 0, 'cleanup must remove the null-keyed entry');
			}
		);

		test('P1 aborted delete: row, secondary-index entry, and blob all survive', async () => {
			const id = 'p1-abort';
			const bucket = 'p1-bucket';
			const blob = blobText(id);

			const putRes = await postJSON('/Item/', { id, bucket, payload: 'x', blob });
			ok(putRes.status < 300, `seed put must succeed; got ${putRes.status}`);

			const preItem = await getItem(id);
			ok(preItem, 'seeded Item must exist before the aborted delete');
			const preEntries = await indexEntriesForId(id);
			strictEqual(preEntries.length, 1, 'seeded Item must be indexed before the aborted delete');
			const preBlob = await getBlob(id);
			strictEqual(preBlob.text, blob, 'seeded blob must be readable before the aborted delete');

			const res = await postJSON('/DeleteAndAbort/', { id });

			const postItem = await getItem(id);
			const entries = await indexEntriesForId(id);
			const postBlob = await getBlob(id);

			console.log(
				`\n[F-147 P1 engine=${ENGINE}] throw status=${res.status} (expect 4xx/5xx)\n` +
					`  Item present after abort=${!!postItem} (expect true)\n` +
					`  raw index entries for id=${JSON.stringify(entries)} (expect 1, value=${bucket})\n` +
					`  blob intact after abort=${postBlob.text === blob} (expect true)\n` +
					`  >>> ${postItem && entries.length === 1 && postBlob.text === blob ? 'ATOMIC — delete rolled back, index and blob intact' : 'DEFECT — delete escaped the aborted transaction'}`
			);

			ok(res.status >= 400, `throwing handler must not return 2xx; got ${res.status}`);
			ok(postItem, 'Item must still exist after the aborted delete (removal must roll back)');
			strictEqual(postItem?.bucket, bucket, 'surviving Item must retain its original bucket');
			strictEqual(
				entries.length,
				1,
				`raw bucket index must still list exactly the surviving Item; got ${JSON.stringify(entries)}`
			);
			strictEqual(
				entries[0]?.indexedValue,
				bucket,
				`surviving index entry must keep its original value; got ${JSON.stringify(entries)}`
			);
			strictEqual(
				postBlob.text,
				blob,
				`blob must survive the aborted delete (removeEntry's blob-unlink gate must not fire); got status=${postBlob.status}`
			);
		});

		test('P2 committed delete: row, secondary-index entry, and blob are all removed', async () => {
			const id = 'p2-commit';
			const bucket = 'p2-bucket';
			const blob = blobText(id);

			const putRes = await postJSON('/Item/', { id, bucket, payload: 'x', blob });
			ok(putRes.status < 300, `seed put must succeed; got ${putRes.status}`);
			strictEqual((await indexEntriesForId(id)).length, 1, 'seeded Item must be indexed before delete');
			strictEqual((await getBlob(id)).text, blob, 'seeded blob must be readable before delete');

			const res = await postJSON('/DeleteAndCommit/', { id });
			strictEqual(res.status, 200, `DeleteAndCommit must succeed; got ${res.status}`);

			const postItem = await getItem(id);
			// Raw read, under ANY indexed value (not just `bucket`) — a committed delete that only
			// cleaned up the real-valued entry but left a null-keyed phantom must still fail here.
			const entries = await indexEntriesForId(id);
			const postBlob = await getBlob(id);

			ok(!postItem, 'Item must be gone after a normal (non-aborted) delete');
			strictEqual(
				entries.length,
				0,
				`no raw index entry (under any value) may survive a committed delete; got ${JSON.stringify(entries)}`
			);
			strictEqual(postBlob.status, 404, `blob must be gone after a committed delete; got status=${postBlob.status}`);
		});
	}
);
