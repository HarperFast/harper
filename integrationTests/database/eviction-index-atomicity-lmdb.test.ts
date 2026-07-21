/**
 * F-149 engine-gap closure — does TTL/expiration eviction orphan raw secondary-index entries on
 * the LMDB storage engine too, or is it RocksDB-specific?
 *
 * Background. QA-611 (-> F-149, HIGH) ran the direct-store (non-blind, D-230/D-232-safe) oracle
 * (exploratory, unpromoted — it characterizes an open defect) against RocksDB and found
 * TTL eviction of an `@indexed` table leaves 100% of raw secondary-index entries dangling: the
 * base table drains to 0 (eviction really ran) but the raw index DBI keeps every entry
 * (phantom=N, missing=0), reproducing at 1 and 4 workers, audit-independent. Root cause traced to
 * the eviction batcher's `updateIndices(...,{transaction})` using a txn bound to
 * `primaryStore.store` (Table.ts ~5573/5589) instead of the index store — so the index-side
 * delete silently no-ops against the wrong transaction while the base-row delete (on the txn it's
 * actually bound to) commits fine. There is also a separate non-batched evict() path around
 * Table.ts ~5749 not covered by this repro. Whether LMDB shares this behavior was an OPEN
 * question — LMDB has its own index/primary store wiring and its own long-transaction monitor
 * semantics (LMDBTransaction.ts hardcodes a 30s over-time threshold, ignoring
 * maxTransactionOpenTime — see integrationTests/database/eviction-secondary-index.test.ts), so
 * nothing about the RocksDB finding was safe to assume for LMDB without re-running the direct
 * oracle against it.
 *
 * This file is the LMDB variant of the QA-611 harness: same fixture shape (ItemF audit:false /
 * ItemT audit:true, both expiration:1s; Widget for the positive control), same direct-store
 * oracle (IndexDump/IndexRangeAll/PrimaryIds reading raw DBIs via .getRange(), no join through
 * the primary record -> immune to Table.ts transformToEntries()'s `if (!record) return SKIP`
 * join-skip that makes search_by_value structurally blind to dangling index entries).
 *
 * Engine selection + hard assertion (do not just assume the env var worked).
 *   resources/databases.ts `database()`:
 *     const useRocksdb = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) !== 'lmdb';
 *   confirms HARPER_STORAGE_ENGINE is checked BEFORE the config-file storage_engine key and wins
 *   when set to 'lmdb'. integrationTests/database/eviction-secondary-index.test.ts (the existing
 *   dual-engine P-133/QA-179 sibling) uses exactly this env var as its lmdb-repro mechanism. Here
 *   it's set via setupHarperWithFixture's `env` option, which harperLifecycle.ts spawns the
 *   process with as `{ ...process.env, ...env }` — so it's forced regardless of the ambient shell
 *   env the test runner itself was invoked with.
 *   HARD ASSERT: a new StorageEngineInfo resource (this fixture's resources.js) reports two
 *   independent, code-derived signals instead of trusting the env var: (1) primaryStore.path ends
 *   in `.mdb` (databases.ts opens LMDB envs at `<name>.mdb`, RocksDB at a bare directory), and
 *   (2) the category index exposes `.prefetch` (Table.ts ~4758: `isLMDB = !!index.prefetch`,
 *   RocksDB indices don't have it). Both must agree engine=lmdb before Part A/B run.
 *
 * Oracle discipline (D-232): search_by_value is NOT used as the oracle (D-230-blind to dangling
 * index entries by construction). Part A originally tried reusing the proven F-147
 * DeleteThenAbort mechanism (delete + same-txn abort) on a dedicated non-TTL Widget table to
 * inject a KNOWN-dangling raw index entry, the way QA-611 did on RocksDB. It does NOT reproduce
 * on LMDB (A2, informational): the primary row comes back after the abort (point read settles to
 * 200, not 404) -- delete+abort appears genuinely symmetric/atomic on this engine, unlike
 * RocksDB. D-232 only requires proving the oracle can see a dangling entry when one exists, not
 * that F-147 specifically produce it, so A3 builds one directly (InjectDanglingIndex: a normal
 * put, then a primaryStore.remove() that bypasses updateIndices()) and is the actual gate.
 *
 * QA-614 oracle fix: QA-613's PrimaryIds resource called `.map((entry) => entry.key)` after
 * `t.primaryStore.getRange({ values: false })`. Per lmdb-js read.js, when both includeValues and
 * includeVersions are falsy the iterator yields the BARE KEY as each entry (no `{key,...}`
 * wrapper) -- so `entry.key` was `undefined` on every row, and all 750 `undefined`s collapsed
 * into one `"undefined"` string once the test Set-deduped them (`new Set(ids.map(String))`),
 * which is exactly QA-613's "1 of 750" symptom. It was not a `start`/snapshot bound issue.
 * Fixed by requesting `versions: true` (as Table.ts's own full-range primaryStore scans do,
 * e.g. the cleanup-scan ~line 5724), which switches the iterator to the `{key, version}`-wrapped
 * shape that `.map((entry) => entry.key)` actually expects.
 *
 * Precondition asserts (D-225): TableInfo confirms audit:false/true actually took effect;
 * PrimaryIds confirms the base table actually drains to 0 (eviction really ran) before the
 * phantom/missing verdict is read.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   timeout 600 npm run test:integration -- "integrationTests/database/eviction-index-atomicity-lmdb.test.ts"
 *   (single worker: QA611_WORKERS=1 npm run test:integration -- "integrationTests/database/eviction-index-atomicity-lmdb.test.ts")
 * Verified green on harper 1e1edc666 (promoted from QA-614).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
const { ok, strictEqual } = assert;
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'eviction-index-atomicity-lmdb');
const WORKERS = Number(process.env.QA611_WORKERS ?? '4');
const skipSuite = process.platform === 'win32';

const MAX_TXN_OPEN_MS = 500;
const CATEGORIES = ['e1', 'e2', 'e3', 'e4', 'e5'];
const ROWS_PER_CATEGORY = 150; // 750 rows/table

suite(
	`F-149 LMDB TTL eviction x secondary-index direct-store oracle [engine=lmdb(forced) workers=${WORKERS}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let procOutput = '';
		const findings: string[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKERS },
					storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
					logging: { console: true, level: 'error' },
				},
				// Force LMDB regardless of the ambient shell env the test runner was invoked with.
				env: { HARPER_STORAGE_ENGINE: 'lmdb' },
			});
			client = createApiClient(ctx.harper);

			// Poll for route readiness (component is pre-installed via config.yaml; no restart
			// needed). An earlier revision called restartHttpWorkers() here, but that op's HTTP
			// response resolves as soon as the restart job is *launched* (server/jobs/jobRunner.ts
			// launchJobThread does not await the job thread's actual work), not once workers have
			// actually cycled. Against a pre-installed fixture the probe path is already non-404 from
			// the moment the process boots, so the readiness poll passed trivially before the real
			// restart (tearing down + respawning all `threads.count` workers) had finished — leaving
			// it to race the tests that follow and intermittently ECONNREFUSE them (reliably
			// reproduced under CI's more contended, WORKERS=4 timing). Since nothing here needs the
			// restart in the first place, just poll for readiness directly, matching the established
			// pattern in eviction-secondary-index.test.ts's sibling fixture.
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await request(client.restURL).get('/ItemF/').set(client.headers).timeout(2000);
						if (probe.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}

			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			const proc = ctx.harper.process;
			proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			findings.push(`Engine requested: lmdb (via HARPER_STORAGE_ENGINE), workers: ${WORKERS}`);
			findings.push(
				'Oracle: DIRECT-STORE (non-blind) — IndexDump/IndexRangeAll/PrimaryIds read the raw index dbi and raw primary-store dbi via .getRange(), no join through the primary record.'
			);
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log(`\n[F-149-LMDB workers=${WORKERS}] FINDINGS`);
			for (const f of findings) console.log('  ' + f);
		});

		function getJSON(path: string) {
			return fetch(`${ctx.harper.httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}
		function postJSON(path: string, body: unknown) {
			return fetch(`${ctx.harper.httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}

		async function seed(table: string, id: string, category: string, value: string) {
			await request(client.restURL)
				.put(`/${table}/${id}`)
				.set(client.headers)
				.send({ id, category, value })
				.expect(204);
		}
		async function pointRead(table: string, id: string): Promise<{ status: number; body?: any }> {
			const r = await request(client.restURL).get(`/${table}/${id}`).set(client.headers);
			return { status: r.status, body: r.body };
		}
		async function indexDump(table: string, category: string): Promise<string[]> {
			const r = await getJSON(
				`/IndexDump/?table=${encodeURIComponent(table)}&category=${encodeURIComponent(category)}`
			);
			strictEqual(r.status, 200, `IndexDump should return 200 for table=${table}`);
			const body = (await r.json()) as { ids?: string[] };
			return (body.ids ?? []).map(String);
		}
		async function indexRangeAll(table: string): Promise<Array<{ key: string; value: string }>> {
			const r = await getJSON(`/IndexRangeAll/?table=${encodeURIComponent(table)}`);
			strictEqual(r.status, 200, `IndexRangeAll should return 200 for table=${table}`);
			const body = (await r.json()) as { entries?: Array<{ key: string; value: string }> };
			return body.entries ?? [];
		}
		async function primaryIds(table: string): Promise<Set<string>> {
			const r = await getJSON(`/PrimaryIds/?table=${encodeURIComponent(table)}`);
			strictEqual(r.status, 200, `PrimaryIds should return 200 for table=${table}`);
			const body = (await r.json()) as { ids?: string[] };
			return new Set((body.ids ?? []).map(String));
		}
		async function tableInfo(table: string): Promise<{ audit: boolean; hasAuditStore: boolean }> {
			const r = await getJSON(`/TableInfo/?table=${encodeURIComponent(table)}`);
			strictEqual(r.status, 200, `TableInfo should return 200 for table=${table}`);
			return (await r.json()) as { audit: boolean; hasAuditStore: boolean };
		}
		async function storageEngineInfo(table: string): Promise<{
			primaryPath: string | null;
			indexHasPrefetch: boolean;
			primaryHasPrefetch: boolean;
			looksLikeLmdbPath: boolean;
			engineGuess: string;
		}> {
			const r = await getJSON(`/StorageEngineInfo/?table=${encodeURIComponent(table)}`);
			strictEqual(r.status, 200, `StorageEngineInfo should return 200 for table=${table}`);
			return await r.json();
		}

		// ---- 0. Preconditions ----
		test('0a precondition: storage engine in effect is LMDB (hard assert, not assumed)', async () => {
			const info = await storageEngineInfo('ItemF');
			findings.push(`StorageEngineInfo(ItemF) = ${JSON.stringify(info)}`);
			ok(
				info.looksLikeLmdbPath,
				`PRECONDITION: primaryStore.path must end in .mdb (LMDB), got ${JSON.stringify(info)}`
			);
			ok(
				info.indexHasPrefetch || info.primaryHasPrefetch,
				`PRECONDITION: LMDB stores/indices must expose .prefetch, got ${JSON.stringify(info)}`
			);
			strictEqual(info.engineGuess, 'lmdb', `PRECONDITION: engine in effect must be lmdb, got ${JSON.stringify(info)}`);
		});
		test('0b precondition: ItemF has audit=false in effect', async () => {
			const info = await tableInfo('ItemF');
			findings.push(`TableInfo(ItemF) = ${JSON.stringify(info)}`);
			strictEqual(info.audit, false, 'PRECONDITION: ItemF must have audit=false in effect');
		});
		test('0c precondition: ItemT has audit=true in effect', async () => {
			const info = await tableInfo('ItemT');
			findings.push(`TableInfo(ItemT) = ${JSON.stringify(info)}`);
			strictEqual(info.audit, true, 'PRECONDITION: ItemT must have audit=true in effect');
		});

		// ======================================================================================
		// PART A — D-232 positive control: does the direct-store oracle actually detect a KNOWN
		// dangling raw index entry on LMDB? (Without this, a later "0 dangling" is unearned.)
		// ======================================================================================

		test('A1 control: direct-store oracle discriminates — sees a live entry, clears it after a clean delete', async () => {
			await seed('Widget', 'a1-clean', 'a1-clean-cat', 'v');
			const before1 = await indexDump('Widget', 'a1-clean-cat');
			ok(
				before1.includes('a1-clean'),
				`PRECONDITION: oracle must see a1-clean before delete (got ${JSON.stringify(before1)})`
			);
			await request(client.restURL).delete('/Widget/a1-clean').set(client.headers).expect(200);
			const after1 = await indexDump('Widget', 'a1-clean-cat');
			findings.push(`A1: index after clean (non-aborted) delete = ${JSON.stringify(after1)}`);
			strictEqual(after1.includes('a1-clean'), false, 'a normal delete must clear the raw index entry');
		});

		test('A2 INFORMATIONAL: does the F-147 DeleteThenAbort mechanism reproduce on LMDB? (not the D-232 gate — see A3)', async () => {
			// QA-613 tried to reuse F-147 (proven on RocksDB: delete + same-txn abort leaves the
			// primary row deleted but the index entry intact) as the LMDB positive control and it
			// did not fire within the window. Confirmed here too, with generous polling: on LMDB the
			// primary row comes BACK (point read settles to 200, not 404) after delete+abort, i.e.
			// the delete is rolled back symmetrically with the index update. This is a real engine
			// behavior difference worth recording, but it means F-147 cannot serve as the LMDB
			// positive-control mechanism — A3 below builds one directly instead. This test is
			// informational only (does not gate the suite).
			await seed('Widget', 'a2-known', 'a2-known-cat', 'v');
			const res = await postJSON('/DeleteThenAbort/', { table: 'Widget', id: 'a2-known' });
			ok(res.status >= 500, `PRECONDITION: DeleteThenAbort must return 5xx (abort path entered), got ${res.status}`);
			await sleep(300);

			let pr = await pointRead('Widget', 'a2-known');
			const diagStart = Date.now();
			while (pr.status !== 404 && Date.now() - diagStart < 5000) {
				await sleep(200);
				pr = await pointRead('Widget', 'a2-known');
			}
			const settledMs = Date.now() - diagStart;
			const directIds = await indexDump('Widget', 'a2-known-cat');
			findings.push(
				`A2 INFORMATIONAL: pointRead settled to status=${pr.status} after ${settledMs}ms; IndexDump(a2-known-cat)=${JSON.stringify(directIds)} — ` +
					(pr.status === 404
						? 'F-147 DID reproduce on LMDB (primary gone, check index for danglers above).'
						: 'F-147 did NOT reproduce on LMDB within the window (primary row came back — delete+abort appears symmetric/atomic here, unlike RocksDB). Not used as the D-232 gate; see A3.')
			);
			// Cleanup: whichever state we ended up in, remove the row so it doesn't pollute later assertions.
			await request(client.restURL).delete('/Widget/a2-known').set(client.headers);
		});

		test('A3 D-232 POSITIVE CONTROL (synthetic): direct-store-injected dangling entry — oracle must detect it on LMDB', async () => {
			// Independent of whether any particular Harper code path (F-147 or otherwise) produces a
			// dangling raw index entry on LMDB, D-232 only requires proving the oracle CAN see one
			// when it genuinely exists. Construct that state directly: a normal REST put (durably
			// committed, `.expect(204)`, indexed normally), then a SEPARATE request that calls
			// primaryStore.remove() at the store level, bypassing updateIndices() and deliberately
			// leaving the raw index entry behind. Splitting the put and the low-level remove into two
			// requests (rather than one handler) avoids racing the put's own event-turn write
			// batching against the raw store call.
			await seed('Widget', 'a3-known', 'a3-known-cat', 'v');
			const preIds = await indexDump('Widget', 'a3-known-cat');
			ok(
				preIds.includes('a3-known'),
				`PRECONDITION: oracle must see a3-known indexed before the raw remove (got ${JSON.stringify(preIds)})`
			);

			const res = await postJSON('/RemoveFromPrimaryOnly/', { table: 'Widget', id: 'a3-known' });
			strictEqual(res.status, 200, `PRECONDITION: RemoveFromPrimaryOnly must succeed, got ${res.status}`);
			const resBody = await res.json();
			ok(
				resBody.removed,
				`PRECONDITION: primaryStore.remove() must report the row as removed, got ${JSON.stringify(resBody)}`
			);

			const pr = await pointRead('Widget', 'a3-known');
			findings.push(`A3: pointRead(a3-known) after direct primaryStore.remove() = ${pr.status}`);
			strictEqual(pr.status, 404, 'PRECONDITION: primary row must be gone (synthetic dangling-entry construction)');

			const directIds = await indexDump('Widget', 'a3-known-cat');
			findings.push(`A3: direct-store IndexDump(a3-known-cat) on LMDB = ${JSON.stringify(directIds)}`);
			ok(
				directIds.includes('a3-known'),
				`D-232 CONTROL FAILED: direct-store oracle did not see the known-dangling entry on LMDB, got ${JSON.stringify(directIds)}`
			);
			findings.push(
				`A3 VERDICT: positive control FIRED on LMDB (synthetic dangling entry detected, count=${directIds.length}) — the ` +
					`raw-index oracle works on this engine, so a "0 dangling" result in Part B below is earned, not vacuous.`
			);
		});

		// ======================================================================================
		// PART B — the F-149 question: does TTL eviction orphan raw secondary-index entries on LMDB?
		// ======================================================================================

		for (const table of ['ItemF', 'ItemT']) {
			test(`B [${table}]: TTL-eviction sweep on LMDB — base vs raw-index count after full eviction`, async () => {
				const t0 = Date.now();

				await Promise.all(
					CATEGORIES.map((category) =>
						postJSON('/SeedItems/', { table, category, count: ROWS_PER_CATEGORY, prefix: category }).then((r) => {
							if (r.status !== 200) throw new Error(`SeedItems ${table}/${category} status ${r.status}`);
						})
					)
				);
				const seedElapsedMs = Date.now() - t0;

				// Sanity: everything present and indexed immediately after seeding.
				const tPreBase0 = Date.now();
				const preBase = await primaryIds(table);
				const tPreBase1 = Date.now();
				const preIndex = await indexRangeAll(table);
				const tPreIndex1 = Date.now();
				findings.push(
					`B[${table}]: seeded ${CATEGORIES.length}x${ROWS_PER_CATEGORY}=${CATEGORIES.length * ROWS_PER_CATEGORY} rows in ${seedElapsedMs}ms; ` +
						`pre-expiry base=${preBase.size} (readMs=${tPreBase1 - tPreBase0}) index=${preIndex.length} (readMs=${tPreIndex1 - tPreBase1})`
				);
				strictEqual(preBase.size, CATEGORIES.length * ROWS_PER_CATEGORY, 'all rows present pre-expiry (base)');
				strictEqual(preIndex.length, CATEGORIES.length * ROWS_PER_CATEGORY, 'all rows present pre-expiry (index)');

				// Let expiration (1s) elapse and the periodic sweep run several cycles with ZERO
				// intervening reads (isolates the periodic-sweep-only eviction path).
				await sleep(4_000);

				let base = await primaryIds(table);
				let indexEntries = await indexRangeAll(table);
				let indexIds = new Set(indexEntries.map((e) => e.value));

				// D-225 precondition: if the sweep hasn't fully drained yet, poll longer before reading
				// the final verdict — but never let a still-draining base explain away a 0-drain base
				// finding on the index side.
				if (base.size > 0 || indexIds.size > 0) {
					const deadline = Date.now() + 20_000;
					while (Date.now() < deadline && base.size > 0) {
						await sleep(1_000);
						base = await primaryIds(table);
						indexEntries = await indexRangeAll(table);
						indexIds = new Set(indexEntries.map((e) => e.value));
					}
				}

				const phantom = [...indexIds].filter((id) => !base.has(id)); // index hit, no base row
				const missing = [...base].filter((id) => !indexIds.has(id)); // base row, no index hit

				findings.push(
					`B[${table}] FINAL (LMDB): base=${base.size} index=${indexIds.size} phantom=${phantom.length}` +
						`${phantom.length ? ' ' + JSON.stringify(phantom.slice(0, 10)) : ''} missing=${missing.length}` +
						`${missing.length ? ' ' + JSON.stringify(missing.slice(0, 10)) : ''}\n` +
						`  >>> ${
							phantom.length === 0 && missing.length === 0 && base.size === 0 && indexIds.size === 0
								? 'CONSISTENT on LMDB: all rows evicted, no residue in either store (EXPECTED / RocksDB-specific)'
								: base.size === 0 && phantom.length > 0
									? `DEFECT: F-149 EXTENDS TO LMDB — base drained to 0 but ${phantom.length} raw secondary-index entries remain dangling`
									: `INCONCLUSIVE: base has not drained (base=${base.size}) within the wait window`
						}`
				);

				// D-225 precondition: eviction must have actually run (base drained to 0) before the
				// phantom/missing verdict below means anything.
				strictEqual(
					base.size,
					0,
					`PRECONDITION: ${table} base store must fully drain via TTL eviction, ${base.size} rows remain`
				);

				// The F-149 question itself.
				strictEqual(
					phantom.length,
					0,
					`${table}: F-149 EXTENDS TO LMDB — ${phantom.length} dangling raw index entries survive full eviction: ${JSON.stringify(phantom)}`
				);
				strictEqual(
					missing.length,
					0,
					`${table}: ${missing.length} base rows missing from the raw index after eviction: ${JSON.stringify(missing)}`
				);
				strictEqual(
					indexIds.size,
					0,
					`${table}: all rows should be fully evicted from the index, ${indexIds.size} remain`
				);
			});
		}
	}
);
