/**
 * P-133 / QA-179 — TTL background expiration/eviction sweep vs secondary-index consistency under
 * long-transaction force-commit.
 *
 * Sibling to QA-176 (which confirmed the EXPLICIT-WRITE force-commit path keeps the secondary
 * index consistent). The TTL expiration/eviction DELETE is a DIFFERENT code path
 * (resources/Table.ts scheduleCleanup() -> TableResource.evict(), plus
 * runRecordExpirationEviction()), but it ALSO must keep the base store and a secondary @indexed
 * index consistent. Each evict() opens its OWN DatabaseTransaction, getReadTxn() (registering it
 * with the long-transaction monitor), removes the @indexed entry (updateIndices(id, rec, null))
 * AND the base row (removeEntry()), then commits. The cleanup sweep runs on the last worker
 * (threads.count-1) with up to MAX_CLEANUP_CONCURRENCY=50 in-flight evict() txns and
 * `await rest()` between scanned records — so with storage.maxTransactionOpenTime:1 +
 * debugLongTransactions:true the over-time monitor (DatabaseTransaction.ts / LMDBTransaction.ts)
 * can force-commit / abort a tracked eviction txn mid-flight. Sibling QA-174 saw the over-time
 * line fire 1500-2968x/run on RocksDB under these settings.
 *
 * The fear: a force-committed eviction splits the index-entry-delete from the base-row-delete,
 * leaving either a PHANTOM (index hit whose base row is gone) or a MISSING (surviving base row
 * absent from the index).
 *
 * Oracle: raw secondary-index reads, never search_by_value. search_by_value joins every hit
 * back through the primary record (resources/Table.ts, `if (record == null) return canSkip ?
 * SKIP : record`) and silently drops any hit whose record is gone — the exact dangling/phantom
 * shape this suite exists to catch. A value-scoped raw check is also insufficient on its own: a
 * regression that leaves a null-keyed phantom (`[null, id]`, the F-175 shape in
 * eviction-index-phantom-null-keys.test.ts) would pass a check scoped to one bucket value. And
 * reading the raw index and the raw primary rows as two separate requests races the live
 * background sweep: a row can be atomically evicted between the two reads and get misreported as
 * a phantom despite correct atomic behavior. `/RawSnapshot/` (resources.js) closes both gaps: one
 * request reads the whole index (including null keys) and the whole primary store under ONE
 * shared transaction (`Table._readTxnForContext`), so the two reads reflect the same instant.
 *   Phantom: a raw index entry (any value, incl. null) whose (id, value) has no matching base row.
 *   Missing: a surviving base row whose (id, value) has no matching raw index entry.
 * `Q(-1)` plants both a real-valued and a null-keyed dangling entry (bypassing the record layer,
 * like table-clear-secondary-index.test.ts's Q0) to prove the raw oracle actually sees both
 * shapes before any of Q1/Q2's "0 phantom/missing" results are trusted.
 *
 * We mix rows that EXPIRE (table Expiring, expiration:4s) with CONTROL rows that DON'T
 * (table Permanent, no TTL). The index should retain exactly the survivors: after the sweep,
 * Expiring -> empty (0 base, 0 index, any value); Permanent -> all rows present AND fully indexed.
 *
 * Runs both engines: default (RocksDB) and HARPER_STORAGE_ENGINE=lmdb. NB (QA-176): LMDB's
 * monitor hardcodes a 30s threshold and ignores maxTransactionOpenTime (LMDBTransaction.ts),
 * so the force-commit path may not be reachable on LMDB within a short sweep — if the over-time
 * line never fires, the LMDB leg is INCONCLUSIVE for force-commit and reports plain-eviction
 * consistency only.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/eviction-secondary-index.test.ts"
 *   (lmdb: HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/eviction-secondary-index.test.ts")
 * Harper SHA: 7aaa5a152
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from './../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'eviction-secondary-index');
const SCHEMA = 'data';
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
// Low over-time threshold so the monitor force-commits any tracked eviction txn that crosses it.
// (RocksDB honors this; LMDB hardcodes 30s and ignores it — see header.)
const MAX_TXN_OPEN_MS = 5;
// Buckets in the expiring table (all expire). Enough rows that the sweep takes several
// `await rest()` ticks and runs many concurrent evict() txns under monitor pressure.
const EXPIRING_BUCKETS = ['E1', 'E2', 'E3', 'E4'];
const ROWS_PER_EXPIRING_BUCKET = 30; // 120 expiring rows total
const PERMANENT_BUCKET = 'P1';
const ROWS_PERMANENT = 20;

const skipSuite = process.platform === 'win32';

suite(`QA-179 TTL eviction sweep vs secondary index [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	// Live capture of Harper's stdout/stderr so we can confirm the over-time line actually fired.
	let procOutput = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
				logging: { console: true, level: 'error' },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		// Seed captured startup output, then keep listening for the over-time line.
		procOutput += ctx.harper.startupOutput?.stdout ?? '';
		procOutput += ctx.harper.startupOutput?.stderr ?? '';
		const proc = ctx.harper.process;
		proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
		proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

		// Wait for route readiness (component is pre-installed; no restart needed).
		await waitForRouteReady(client, '/Expiring/', 120_000);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function postJSON(path: string, body: unknown): Promise<Response> {
		return fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify(body),
		});
	}

	function sawOverTime(): boolean {
		let logText = '';
		const logDir = (ctx.harper as any).logDir as string | undefined;
		if (logDir) {
			for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
				const p = join(logDir, name);
				if (existsSync(p)) {
					try {
						logText += readFileSync(p, 'utf8');
					} catch {
						/* ignore */
					}
				}
			}
		}
		return /Transaction was open too long/i.test(logText) || /Transaction was open too long/i.test(procOutput);
	}

	function countOverTime(): number {
		let logText = '';
		const logDir = (ctx.harper as any).logDir as string | undefined;
		if (logDir) {
			for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
				const p = join(logDir, name);
				if (existsSync(p)) {
					try {
						logText += readFileSync(p, 'utf8');
					} catch {
						/* ignore */
					}
				}
			}
		}
		const all = logText + procOutput;
		return (all.match(/Transaction was open too long/gi) || []).length;
	}

	/** search_by_value(table, bucket) -> Set<id> via the operations API (secondary-index path). */
	async function searchByBucket(table: string, bucket: string): Promise<Set<string>> {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: SCHEMA,
				table,
				search_attribute: 'bucket',
				search_value: bucket,
				get_attributes: ['id', 'bucket'],
			})
			.timeout(60_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return new Set(rows.map((row) => String(row.id)));
	}

	/** Full base-table scan via the custom Dump resource (index-independent). */
	async function dumpBase(dumpPath: string): Promise<Array<{ id: string; bucket: string; seq: number }>> {
		const r = await fetch(`${httpURL}${dumpPath}`, { headers: { Authorization: client.headers.Authorization } });
		strictEqual(r.status, 200, `${dumpPath} should return 200`);
		return (await r.json()) as Array<{ id: string; bucket: string; seq: number }>;
	}

	interface RawRow {
		id: string;
		bucket: string;
		seq: number;
	}
	interface RawIndexEntry {
		indexedValue: unknown;
		primaryKey: string;
	}
	interface TableSnapshot {
		rows: RawRow[];
		indexEntries: RawIndexEntry[];
	}

	/**
	 * One table's primary rows + raw secondary-index entries, read under ONE shared transaction
	 * (resources.js's RawSnapshot) — never joins through the primary record like search_by_value,
	 * and the two reads cannot straddle a concurrent eviction commit. `rows` is physical-presence
	 * truth (unlike `dumpBase`'s `Table.search()`, which applies expiration semantics);
	 * `indexEntries` includes null-keyed phantoms (an unqualified getRange() would skip them).
	 */
	async function rawSnapshot(table: string): Promise<TableSnapshot> {
		const r = await fetch(`${httpURL}/RawSnapshot/?table=${table}&attr=bucket`, { headers: client.headers });
		strictEqual(r.status, 200, `/RawSnapshot/?table=${table} should return 200`);
		return (await r.json()) as TableSnapshot;
	}

	/**
	 * Whole-table consistency, over EVERY stored value including null — not scoped to one
	 * bucket, so a null-keyed phantom (F-175) cannot hide from a check that only looked at the
	 * bucket value a test happened to load.
	 *  phantom: a raw index entry whose (indexedValue, primaryKey) has no matching live base row.
	 *  missing: a surviving base row whose (bucket, id) has no matching raw index entry.
	 */
	function analyzeSnapshot(snap: TableSnapshot) {
		const phantom = snap.indexEntries.filter(
			(e) => !snap.rows.some((r) => r.id === e.primaryKey && r.bucket === e.indexedValue)
		);
		const missing = snap.rows.filter(
			(r) => !snap.indexEntries.some((e) => e.primaryKey === r.id && e.indexedValue === r.bucket)
		);
		return { phantom, missing, baseCount: snap.rows.length, indexCount: snap.indexEntries.length };
	}

	/** Per-bucket slice of one snapshot, for diagnostic logging only — analyzeSnapshot() above,
	 * over the whole table, is what the assertions use. */
	function bucketBreakdown(snap: TableSnapshot, bucket: string) {
		const rows = snap.rows.filter((r) => r.bucket === bucket);
		const entries = snap.indexEntries.filter((e) => e.indexedValue === bucket);
		return {
			baseCount: rows.length,
			indexCount: entries.length,
			phantom: entries.filter((e) => !rows.some((r) => r.id === e.primaryKey)).length,
			missing: rows.filter((r) => !entries.some((e) => e.primaryKey === r.id)).length,
		};
	}

	// ---- Q(-1): prove the raw oracle is NOT blind before trusting any "0 phantom/missing" result -
	test(
		'Q(-1) oracle self-proof: a planted real-valued AND null-keyed dangling entry are both visible',
		{ timeout: 15_000 },
		async () => {
			// Tables are empty at this point. Write directly into the raw bucket index dbi with no
			// corresponding primary row -- the F-149 (real-valued) and F-175 (null-keyed) phantom
			// shapes Q1/Q2's assertions below must both be able to detect.
			const plantReal = await postJSON('/PlantDangling/', {
				table: 'Expiring',
				attr: 'bucket',
				value: 'GHOST',
				key: 'ghost-real',
			});
			strictEqual(plantReal.status, 200, `PlantDangling(real) should return 200, got ${plantReal.status}`);
			const plantNull = await postJSON('/PlantDangling/', {
				table: 'Expiring',
				attr: 'bucket',
				value: null,
				key: 'ghost-null',
			});
			strictEqual(plantNull.status, 200, `PlantDangling(null) should return 200, got ${plantNull.status}`);

			const snap = await rawSnapshot('Expiring');
			const { phantom } = analyzeSnapshot(snap);
			ok(
				phantom.some((p) => p.primaryKey === 'ghost-real' && p.indexedValue === 'GHOST'),
				`oracle must see the planted real-valued dangling entry; phantom=${JSON.stringify(phantom)}`
			);
			ok(
				phantom.some((p) => p.primaryKey === 'ghost-null' && p.indexedValue === null),
				`oracle must see the planted null-keyed dangling entry (F-175); phantom=${JSON.stringify(phantom)}`
			);

			// Clean up before Q0 seeds its own rows, so no stray planted entry skews later counts.
			await postJSON('/RemoveIndexEntry/', { table: 'Expiring', attr: 'bucket', value: 'GHOST', key: 'ghost-real' });
			await postJSON('/RemoveIndexEntry/', { table: 'Expiring', attr: 'bucket', value: null, key: 'ghost-null' });
			const after = await rawSnapshot('Expiring');
			ok(
				!after.indexEntries.some((e) => e.primaryKey === 'ghost-real' || e.primaryKey === 'ghost-null'),
				'cleanup must remove both planted entries'
			);
		}
	);

	// ---- Q0: load expiring + control rows --------------------------------------------------
	test('Q0 load 120 expiring rows + 20 permanent control rows', async () => {
		for (const bucket of EXPIRING_BUCKETS) {
			const res = await postJSON('/Load/', { table: 'Expiring', count: ROWS_PER_EXPIRING_BUCKET, bucket });
			strictEqual(res.status, 200, `load Expiring/${bucket} should succeed`);
		}
		const resP = await postJSON('/Load/', { table: 'Permanent', count: ROWS_PERMANENT, bucket: PERMANENT_BUCKET });
		strictEqual(resP.status, 200, 'load Permanent should succeed');

		// Sanity: rows are present immediately, index resolves them.
		const eBase = await dumpBase('/DumpE/');
		const pBase = await dumpBase('/DumpP/');
		strictEqual(
			eBase.length,
			EXPIRING_BUCKETS.length * ROWS_PER_EXPIRING_BUCKET,
			'all expiring rows present pre-expiry'
		);
		strictEqual(pBase.length, ROWS_PERMANENT, 'all permanent rows present');
		const e1Index = await searchByBucket('Expiring', 'E1');
		strictEqual(e1Index.size, ROWS_PER_EXPIRING_BUCKET, 'E1 fully indexed pre-expiry');
		console.log(`[QA-179 Q0 ${ENGINE}] loaded expiring=${eBase.length} permanent=${pBase.length}`);
	});

	// ---- Q1: mid-eviction snapshot — index/base consistent WHILE rows are being evicted -----
	test('a progressing scan survives monitor ticks during the eviction window', async () => {
		const response = await fetch(`${httpURL}/PacedDumpP/`, { headers: client.headers });
		const body = await response.text();
		strictEqual(response.status, 200, body);
		const ids = JSON.parse(body);
		strictEqual(ids.length, ROWS_PERMANENT);
		strictEqual(new Set(ids).size, ROWS_PERMANENT);
	});

	test('Q1 mid-eviction: index/base stay consistent during the sweep', { timeout: 60_000 }, async () => {
		// expiration:4s, scanInterval:2s. Rows become evictable at ~t=4s after load; the sweep
		// fires every ~2s. Sample partway through the sweep (some evicted, some not) so a split
		// force-committed eviction would surface as a phantom/missing right here. One RawSnapshot
		// call covers all 4 buckets under one shared transaction, so this sample cannot straddle
		// a concurrent evict() commit the way 4 separate search_by_value calls could.
		await sleep(5_000);
		const snap = await rawSnapshot('Expiring');
		const { phantom, missing, baseCount, indexCount } = analyzeSnapshot(snap);
		for (const bucket of EXPIRING_BUCKETS) {
			const r = bucketBreakdown(snap, bucket);
			console.log(
				`[QA-179 Q1 ${ENGINE}] Expiring/${bucket} base=${r.baseCount} index=${r.indexCount} ` +
					`phantom=${r.phantom} missing=${r.missing}`
			);
		}
		const fired = sawOverTime();
		console.log(
			`\n[QA-179 Q1 ${ENGINE}] mid-eviction survivingExpiringBase=${baseCount} indexEntries=${indexCount} ` +
				`overTimeFired=${fired} count=${countOverTime()} totalPhantom=${phantom.length} totalMissing=${missing.length}\n` +
				`  >>> ${
					phantom.length === 0 && missing.length === 0
						? 'CONSISTENT mid-eviction (green anchor)'
						: `ORPHANED INDEX ENTRIES (DEFECT): ${phantom.length} phantom + ${missing.length} missing`
				}`
		);
		strictEqual(
			phantom.length,
			0,
			`mid-eviction phantom index entries (any value, incl. null): ${JSON.stringify(phantom)}`
		);
		strictEqual(missing.length, 0, `mid-eviction missing index entries: ${JSON.stringify(missing)}`);
	});

	// ---- Q2: after settle — all expiring rows gone from BOTH base and index; control intact --
	test(
		'Q2 post-settle: expiring fully evicted (base+index), permanent fully retained',
		{ timeout: 90_000 },
		async () => {
			// Poll on PHYSICAL presence (RawSnapshot's raw primaryStore scan), not dumpBase's
			// Table.search() (which applies expiration semantics) — a row that is logically expired
			// but not yet physically evicted would otherwise read as "drained" early and manufacture
			// a residual-index false positive below.
			const deadline = Date.now() + 60_000;
			let settled: TableSnapshot | undefined;
			while (Date.now() < deadline) {
				settled = await rawSnapshot('Expiring');
				if (settled.rows.length === 0) break;
				await sleep(1_000);
			}

			// Base oracle: nothing left in the expiring table.
			strictEqual(
				settled!.rows.length,
				0,
				`expiring base table should drain to 0 after eviction, got ${settled!.rows.length}`
			);

			// Index oracle: no residual entry of ANY value (incl. null-keyed) for a fully-evicted table.
			const { phantom: totalPhantom, indexCount: totalIndex } = analyzeSnapshot(settled!);
			for (const bucket of EXPIRING_BUCKETS) {
				const r = bucketBreakdown(settled!, bucket);
				console.log(
					`[QA-179 Q2 ${ENGINE}] Expiring/${bucket} base=${r.baseCount} index=${r.indexCount} phantom=${r.phantom}`
				);
			}

			// Control oracle: the non-expiring table is untouched AND fully indexed (missing check).
			const rP = analyzeSnapshot(await rawSnapshot('Permanent'));

			const fired = sawOverTime();
			const otCount = countOverTime();
			// NOTE (F-041): on LMDB the over-time force-commit path is not reachable in a short sweep
			// (hardcoded 30s threshold); this tests plain-eviction index consistency. The transient
			// eviction phantom window for LMDB under force-commit remains an open known behavior (F-041).
			console.log(
				`\n[QA-179 Q2 ${ENGINE}] overTimeFired=${fired} overTimeCount=${otCount}\n` +
					`  expiring: residualBase=${settled!.rows.length} residualIndex=${totalIndex} phantom=${totalPhantom.length}\n` +
					`  permanent: base=${rP.baseCount} index=${rP.indexCount} phantom=${rP.phantom.length} missing=${rP.missing.length}\n` +
					`  >>> ${
						!fired
							? `INCONCLUSIVE (over-time never fired on ${ENGINE}) — reporting plain-eviction consistency`
							: totalIndex === 0 && totalPhantom.length === 0 && rP.missing.length === 0 && rP.phantom.length === 0
								? 'CONSISTENT under forced over-time eviction (green regression anchor)'
								: `DEFECT: residualIndex=${totalIndex} expiringPhantom=${totalPhantom.length} ` +
									`permMissing=${rP.missing.length} permPhantom=${rP.phantom.length}`
					}`
			);

			// Headline assertions — phantom: no index entry (any value, incl. null) survives a
			// fully-evicted expiring row.
			strictEqual(
				totalIndex,
				0,
				`residual index entries (any value, incl. null) for fully-evicted expiring table: ${totalIndex}`
			);
			strictEqual(totalPhantom.length, 0, `phantom index entries in expiring table: ${JSON.stringify(totalPhantom)}`);
			// Control table must be perfectly consistent — proves the oracle and that the sweep is scoped.
			strictEqual(rP.baseCount, ROWS_PERMANENT, `permanent base rows should all survive: ${rP.baseCount}`);
			strictEqual(
				rP.missing.length,
				0,
				`permanent missing index entries (base->no index): ${JSON.stringify(rP.missing)}`
			);
			strictEqual(
				rP.phantom.length,
				0,
				`permanent phantom index entries (index->no base): ${JSON.stringify(rP.phantom)}`
			);
			// Soft signal: did the force-commit actually fire on this engine?
			ok(true, `over-time fired=${fired} count=${otCount}`);
		}
	);
});
