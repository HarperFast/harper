/**
 * QA-615 — D-232 re-audit of the RETRACTED finding F-041, axis C(expiration-scan) x K(indexed),
 * engine=LMDB. This is a METHODOLOGY re-audit, not a fresh probe.
 *
 * Background.
 *  - F-041 (old): on LMDB, during a TTL/expiration eviction sweep, a secondary `@indexed` entry
 *    was reportedly visible TRANSIENTLY -- the raw index entry still present while its matching
 *    base record's delete had not yet committed (mid-sweep window, no persistent data loss).
 *  - F-041 was RETRACTED to NOT-A-DEFECT by QA-184, which used a single-snapshot JOIN oracle
 *    (index lookup + base-existence check in ONE read-txn). D-230 proved that shape of oracle --
 *    transformToEntries() in resources/Table.ts (~line 5111: `if (!record) return SKIP`) --
 *    SKIPS any index hit whose primary record is absent, i.e. it is STRUCTURALLY BLIND to a
 *    dangling index entry, transient or persistent. So QA-184's retraction was never actually
 *    capable of seeing the phantom it claimed was absent -- UNVERIFIED, not disproven.
 *  - QA-614 (integrationTests/database/eviction-index-atomicity-lmdb.test.ts) re-ran a correct
 *    direct-store oracle against LMDB and found the PERSISTENT end-state clean (phantom=0 after
 *    the sweep settles). That leaves the TRANSIENT window DURING the sweep un-re-audited with a
 *    non-blind oracle -- exactly this file's target.
 *
 * Method.
 *  - Oracle: raw primary-store + raw category-index DBI reads via .getRange() (no join through
 *    the primary record -- immune to D-230's transformToEntries() join-skip). Resources
 *    (IndexDump/IndexRangeAll/PrimaryIds/StorageEngineInfo/TableInfo/RemoveFromPrimaryOnly) are
 *    the QA-611/QA-614 oracle, reused verbatim including the QA-614 fix: lmdb-js's getRange()
 *    yields the BARE KEY when both `values` and `versions` are falsy, so any full-range primary
 *    scan MUST pass `{ versions: true }` or `entry.key` reads `undefined` on every row.
 *  - NEW instrument (SampleOnce, in the fixture's resources.js): a single-shot resource that reads
 *    the raw primary store then the raw index, back-to-back inside one worker (no join through the
 *    primary record), returning one point-in-time phantom check. The TEST drives this in a tight
 *    client-side loop across the whole eviction window -- this is what QA-614 did not do (QA-614
 *    only read the settled state after the sweep). An earlier version of this instrument
 *    (SampleSweep) looped server-side inside ONE 15s-held HTTP request instead; that collided with
 *    Harper's own http-worker rollover (restartHttpWorkers's background drain of the pre-restart
 *    generation can still be in flight several seconds after setup returns) -- a long-held
 *    connection landing on a worker that gets drained mid-request is forcefully closed, which
 *    reproducibly killed the ItemF run 3 of 3 times with `[SocketError: other side closed]`. A
 *    single long request is also a confound in its own right: 15s of tight synchronous scanning in
 *    one handler can starve that worker's event loop and delay unrelated write-transaction commits
 *    past storage.maxTransactionOpenTime, which would make any "transient window" this file found
 *    an artifact of the instrument, not of the eviction path. Many short requests avoid both
 *    problems: a rollover event costs at most one dropped sample, and each sample is fast enough
 *    (single small getRange pair) not to meaningfully perturb the event loop.
 *  - Read order per sample is deliberate: primary FIRST, then index. F-041's hypothesized defect
 *    shape is "primary delete committed, index delete not yet committed" -- i.e. a record already
 *    absent from the primary snapshot but still present in the index snapshot taken immediately
 *    after. That ordering biases toward catching exactly that window (a record that becomes
 *    primary-absent between our index read and our next primary read would just show up as
 *    consistent on both sides of the boundary, not as a false phantom).
 *  - D-232 positive control (mandatory): a synthetic dangling index entry (RemoveFromPrimaryOnly
 *    -- a real put, then a primaryStore.remove() that bypasses updateIndices()) must be detected
 *    by BOTH the existing IndexDump oracle AND the new SampleOnce instrument. A "0 phantom"
 *    result from the SampleOnce loop is unearned unless SampleOnce itself is proven to see a known
 *    phantom, not just IndexDump.
 *  - D-225 precondition: the base store must actually drain to 0 (eviction really ran) before any
 *    phantom/missing verdict is read.
 *  - Engine: HARD-asserted via StorageEngineInfo (primaryStore.path ends `.mdb`, index/primary
 *    expose `.prefetch`), not assumed from the env var.
 *
 * Code-reading context (not asserted on, reported as corroboration): resources/Table.ts
 * `TableResource.evict()` (~line 1742) on LMDB (`primaryStore.ifVersion` truthy) issues the index
 * cleanup and the primary removal as two SEPARATE optimistic writes issued back-to-back with no
 * `await` between them (`primaryStore.ifVersion(id, existingVersion, () => updateIndices(...))`
 * then `removeEntry(...)`), joined only via `Promise.all` for completion tracking -- i.e. not a
 * single explicit transaction wrapping both. Table.ts's own comment on the cleanup-scan loop notes
 * "LMDB keeps the per-record path (eventTurnBatching already coalesces async writes per event
 * turn)", implying lmdb-js's automatic write-batching is expected to land both ops in the same
 * commit since they're queued synchronously in the same tick. That's a plausible mechanism for
 * F-041's retraction being CORRECT on the merits (not just under-tested) -- but it's an inference
 * about lmdb-js internals, not a guarantee, which is exactly why this file probes empirically
 * instead of taking it on faith.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   npm run test:integration -- "integrationTests/database/eviction-index-transient-lmdb.test.ts"
 * Verified green on harper 1e1edc666 (promoted from QA-615).
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
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'eviction-index-transient-lmdb');
const skipSuite = process.platform === 'win32';
const WORKERS = Number(process.env.QA615_WORKERS ?? '4');
const CATEGORIES = ['e1', 'e2', 'e3', 'e4', 'e5'];
const ROWS_PER_CATEGORY = 150; // 750 rows/table, same scale as QA-611/QA-614 for comparability
const SAMPLE_DURATION_MS = 15_000;

suite(
	`QA-615 F-041 transient re-audit [engine=lmdb(forced) workers=${WORKERS}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		const findings: string[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKERS },
					// Deliberately NOT overriding storage.maxTransactionOpenTime/debugLongTransactions here
					// (unlike QA-611/QA-614): that watchdog is unrelated to this file's read-only sampling
					// instrument and, at a 500ms threshold, was tripping Harper's own http-worker rollover
					// machinery against the (now-removed) long-held SampleSweep request -- see the file
					// header for the reproducible failure this caused and why the instrument was redesigned.
					logging: { console: true, level: 'warn' },
				},
				env: { HARPER_STORAGE_ENGINE: 'lmdb' },
			});
			client = createApiClient(ctx.harper);
			await restartHttpWorkers(client, '/ItemF/', 120_000);
			// restartHttpWorkers() resolves once the NEW worker generation is minimally responsive, but
			// the OLD generation's drain/shutdown continues asynchronously in the background for a couple
			// more seconds (confirmed via logs: the background job's "restart-complete" notification lands
			// ~2s after this call returns). A request that happens to land on an old worker mid-drain gets
			// forcefully reset when that worker finally shuts down -- this reproducibly killed the first
			// sampling run 3/3 times (SocketError / ECONNRESET) before this settle delay was added. This is
			// harness-timing plumbing, unrelated to the F-041 question itself.
			await sleep(5_000);
			findings.push(`Engine requested: lmdb (via HARPER_STORAGE_ENGINE), workers: ${WORKERS}`);
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log(`\n[eviction-index-transient-lmdb workers=${WORKERS}] FINDINGS`);
			for (const f of findings) console.log('  ' + f);
		});

		function getJSON(path: string) {
			return fetch(`${ctx.harper.httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}
		function postJSON(path: string, body: unknown, timeoutMs = 60_000) {
			return fetch(`${ctx.harper.httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		}
		async function seed(table: string, id: string, category: string, value: string) {
			await request(client.restURL)
				.put(`/${table}/${id}`)
				.set(client.headers)
				.send({ id, category, value })
				.expect(204);
		}
		async function indexDump(table: string, category: string): Promise<string[]> {
			const r = await getJSON(
				`/IndexDump/?table=${encodeURIComponent(table)}&category=${encodeURIComponent(category)}`
			);
			strictEqual(r.status, 200, `IndexDump should return 200 for table=${table}`);
			const body = (await r.json()) as { ids?: string[] };
			return (body.ids ?? []).map(String);
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
		async function storageEngineInfo(table: string) {
			const r = await getJSON(`/StorageEngineInfo/?table=${encodeURIComponent(table)}`);
			strictEqual(r.status, 200, `StorageEngineInfo should return 200 for table=${table}`);
			return (await r.json()) as {
				primaryPath: string | null;
				indexHasPrefetch: boolean;
				primaryHasPrefetch: boolean;
				looksLikeLmdbPath: boolean;
				engineGuess: string;
			};
		}
		type SampleOnceResult = {
			table: string;
			t: number;
			baseCount: number;
			indexCount: number;
			phantomCount: number;
			phantomIds: string[];
		};
		async function sampleOnce(table: string): Promise<SampleOnceResult> {
			const r = await postJSON('/SampleOnce/', { table }, 10_000);
			strictEqual(r.status, 200, `SampleOnce should return 200 for table=${table}`);
			return (await r.json()) as SampleOnceResult;
		}
		type SampleLoopResult = {
			table: string;
			durationMs: number;
			samples: number;
			phantomSampleCount: number;
			maxPhantomCount: number;
			firstPhantomAtMs: number | null;
			lastPhantomAtMs: number | null;
			phantomSamples: Array<{
				tMs: number;
				phantomCount: number;
				phantomIds: string[];
				baseCount: number;
				indexCount: number;
			}>;
			finalBaseCount: number;
			finalIndexCount: number;
		};
		/** Drives SampleOnce back-to-back (no artificial delay) from the TEST for `durationMs`. Each
		 * call is a short, independent HTTP request/read pair -- see file header for why this replaced
		 * a single long-held server-side loop. */
		async function sampleLoop(table: string, durationMs: number): Promise<SampleLoopResult> {
			const startedAt = Date.now();
			const deadline = startedAt + durationMs;
			let samples = 0;
			let maxPhantomCount = 0;
			let firstPhantomAtMs: number | null = null;
			let lastPhantomAtMs: number | null = null;
			const phantomSamples: SampleLoopResult['phantomSamples'] = [];
			let last: SampleOnceResult | undefined;
			while (Date.now() < deadline) {
				const tSample = Date.now() - startedAt;
				last = await sampleOnce(table);
				samples++;
				if (last.phantomCount > 0) {
					maxPhantomCount = Math.max(maxPhantomCount, last.phantomCount);
					firstPhantomAtMs ??= tSample;
					lastPhantomAtMs = tSample;
					if (phantomSamples.length < 50) {
						phantomSamples.push({
							tMs: tSample,
							phantomCount: last.phantomCount,
							phantomIds: last.phantomIds,
							baseCount: last.baseCount,
							indexCount: last.indexCount,
						});
					}
				}
			}
			return {
				table,
				durationMs,
				samples,
				phantomSampleCount: phantomSamples.length,
				maxPhantomCount,
				firstPhantomAtMs,
				lastPhantomAtMs,
				phantomSamples,
				finalBaseCount: last?.baseCount ?? -1,
				finalIndexCount: last?.indexCount ?? -1,
			};
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
		// PART A -- D-232 positive control. Two instruments are in play here (IndexDump, the
		// QA-611/QA-614 oracle, and SampleOnce/sampleLoop, the new sampler this file adds), and
		// BOTH must be proven to detect a KNOWN synthetic dangling entry before Part C's "no
		// transient phantom observed" result means anything.
		// ======================================================================================

		test('A1 control: IndexDump oracle detects a synthetic dangling entry (RemoveFromPrimaryOnly)', async () => {
			await seed('Widget', 'a1-known', 'a1-known-cat', 'v');
			const preIds = await indexDump('Widget', 'a1-known-cat');
			ok(
				preIds.includes('a1-known'),
				`PRECONDITION: oracle must see a1-known indexed before the raw remove (got ${JSON.stringify(preIds)})`
			);

			const res = await postJSON('/RemoveFromPrimaryOnly/', { table: 'Widget', id: 'a1-known' });
			strictEqual(res.status, 200, `RemoveFromPrimaryOnly must succeed, got ${res.status}`);
			const resBody = (await res.json()) as { removed: boolean };
			ok(
				resBody.removed,
				`PRECONDITION: primaryStore.remove() must report the row as removed, got ${JSON.stringify(resBody)}`
			);

			const pr = await request(client.restURL).get('/Widget/a1-known').set(client.headers);
			strictEqual(pr.status, 404, 'PRECONDITION: primary row must be gone (synthetic dangling-entry construction)');

			const directIds = await indexDump('Widget', 'a1-known-cat');
			findings.push(`A1: IndexDump(a1-known-cat) after synthetic dangle = ${JSON.stringify(directIds)}`);
			ok(
				directIds.includes('a1-known'),
				`D-232 CONTROL FAILED (IndexDump): did not see the known-dangling entry, got ${JSON.stringify(directIds)}`
			);
		});

		test('A2 control (the actual instrument used in Part C): SampleOnce detects the same synthetic dangling entry', async () => {
			// a1-known's dangling index entry is still present (nothing has cleaned it up). Confirm the
			// NEW sampler -- not just IndexDump -- sees it, since SampleOnce (via sampleLoop) is what
			// does the real work in Part C below.
			const result = await sampleLoop('Widget', 300);
			findings.push(
				`A2: SampleOnce(Widget) control run — samples=${result.samples} maxPhantomCount=${result.maxPhantomCount} ` +
					`phantomSampleCount=${result.phantomSampleCount} finalBase=${result.finalBaseCount} finalIndex=${result.finalIndexCount}`
			);
			ok(result.samples > 0, 'PRECONDITION: SampleOnce loop must actually take samples');
			ok(
				result.maxPhantomCount >= 1,
				`D-232 CONTROL FAILED (SampleOnce): did not detect any phantom, got ${JSON.stringify(result)}`
			);
			const sawKnownId = result.phantomSamples.some((s) => s.phantomIds.includes('a1-known'));
			ok(
				sawKnownId,
				`D-232 CONTROL FAILED (SampleOnce): did not see the specific known-dangling id a1-known, got ${JSON.stringify(result.phantomSamples[0])}`
			);
			findings.push(
				'A2 VERDICT: SampleOnce control FIRED — the new instrument is proven to detect a known-dangling entry on LMDB.'
			);
		});

		// ======================================================================================
		// PART B/C -- the F-041 question: sample the raw index store DURING the eviction sweep
		// (not just after it settles) and see whether a raw index entry ever exists while its base
		// record is already gone. The sampleLoop is started BEFORE seeding so it covers the entire
		// lifecycle: empty -> populated -> expired -> evicted -> settled.
		// ======================================================================================

		for (const table of ['ItemF', 'ItemT']) {
			test(`C [${table}]: tight client-driven sampling across the full TTL-eviction sweep`, async () => {
				const loopPromise = sampleLoop(table, SAMPLE_DURATION_MS);

				const t0 = Date.now();
				await Promise.all(
					CATEGORIES.map((category) =>
						postJSON('/SeedItems/', { table, category, count: ROWS_PER_CATEGORY, prefix: category }).then((r) => {
							if (r.status !== 200) throw new Error(`SeedItems ${table}/${category} status ${r.status}`);
						})
					)
				);
				const seedElapsedMs = Date.now() - t0;
				findings.push(`C[${table}]: seeded ${CATEGORIES.length * ROWS_PER_CATEGORY} rows in ${seedElapsedMs}ms`);

				const result = await loopPromise;
				findings.push(
					`C[${table}] sampleLoop result: samples=${result.samples} durationMs=${result.durationMs} ` +
						`phantomSampleCount=${result.phantomSampleCount} maxPhantomCount=${result.maxPhantomCount} ` +
						`firstPhantomAtMs=${result.firstPhantomAtMs} lastPhantomAtMs=${result.lastPhantomAtMs} ` +
						`finalBaseCount=${result.finalBaseCount} finalIndexCount=${result.finalIndexCount}`
				);
				if (result.phantomSamples.length) {
					findings.push(
						`C[${table}] phantom sample detail (first up to 5): ${JSON.stringify(result.phantomSamples.slice(0, 5))}`
					);
				}

				// D-225: eviction must have actually run (base drained to 0). If the sampleLoop's own window
				// wasn't long enough, poll a bit more before declaring the precondition failed -- but this
				// post-window check is NOT part of the transient-window observation; it's the QA-614-style
				// settled-state confirmation, kept separate and labeled as such.
				let base = new Set(await primaryIds(table));
				if (base.size > 0) {
					const deadline = Date.now() + 20_000;
					while (Date.now() < deadline && base.size > 0) {
						await sleep(1_000);
						base = await primaryIds(table);
					}
				}
				findings.push(
					`C[${table}] POST-WINDOW settled-state check (QA-614-style, not the transient probe): base=${base.size}`
				);
				strictEqual(
					base.size,
					0,
					`PRECONDITION (D-225): ${table} base store must fully drain via TTL eviction, ${base.size} rows remain`
				);

				// Sanity: the loop actually covered the sweep window with a meaningful sample count.
				ok(
					result.samples > 50,
					`sampleLoop should have taken >50 samples over ${SAMPLE_DURATION_MS}ms, got ${result.samples}`
				);
				const avgIntervalMs = result.durationMs / Math.max(result.samples, 1);
				findings.push(
					`C[${table}] effective sampling resolution: ${avgIntervalMs.toFixed(2)}ms/sample avg (${result.samples} samples)`
				);

				// The F-041 question itself: did the loop ever observe a raw index entry with no
				// matching base row during the window it covered?
				if (result.maxPhantomCount === 0) {
					findings.push(
						`C[${table}] VERDICT: NO transient phantom observed in ${result.samples} samples over ${result.durationMs}ms ` +
							`(avg sampling resolution ~${avgIntervalMs.toFixed(1)}ms) -- within this harness's sampling resolution, LMDB ` +
							`eviction appears index-atomic for ${table} (audit=${table === 'ItemT'}), both transiently and at settle. This ` +
							`does NOT prove no window can ever exist below ~${avgIntervalMs.toFixed(1)}ms resolution -- see report for that caveat.`
					);
				} else {
					findings.push(
						`C[${table}] VERDICT: TRANSIENT PHANTOM OBSERVED -- ${result.phantomSampleCount} of ${result.samples} samples showed ` +
							`a dangling raw index entry (max concurrent=${result.maxPhantomCount}), first at +${result.firstPhantomAtMs}ms, ` +
							`last at +${result.lastPhantomAtMs}ms. finalIndexCount=${result.finalIndexCount} (0 means it self-resolved by the ` +
							`end of the window -- transient-only; >0 means see the persistent settled-state check above).`
					);
				}
			});
		}
	}
);

// NOT PROMOTED — the RocksDB differential control.
// The originating QA-615 scratch spec also ran the same oracle against RocksDB, where TTL eviction
// orphans every raw secondary-index entry (F-149 / QA-611, root-caused to the eviction batcher's
// updateIndices() being bound to primaryStore's transaction rather than the index store's). That
// leg was run at promotion time and reproduced 200/200 dangling entries, which is what earns the
// "0 dangling on LMDB" result above — the oracle demonstrably discriminates. It is deliberately
// NOT included here: it asserts currently-broken behavior, so it would turn red the day F-149 is
// fixed. The RocksDB side belongs in a defect-characterization test that lands with that fix.
