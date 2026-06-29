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
 * Oracle (per indexed `bucket`, from QA-176):
 *   (1) Phantom: every search_by_value(bucket) hit -> GET by PK must still exist with that bucket.
 *   (2) Missing: every surviving base row of bucket B -> must appear in search_by_value(B).
 * We mix rows that EXPIRE (table Expiring, expiration:4s) with CONTROL rows that DON'T
 * (table Permanent, no TTL). The index should retain exactly the survivors: after the sweep,
 * Expiring -> empty (0 base, 0 index); Permanent -> all rows present AND fully indexed.
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
import { ok, strictEqual } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './../apiTests/utils/client.mjs';

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

		// Poll for route readiness (component is pre-installed; no restart needed)
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Expiring/').timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		}
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

	/** Direct PK GET -> base record (or null). Index-independent. */
	async function getById(table: string, id: string): Promise<{ id: string; bucket: string } | null> {
		const r = await client
			.req()
			.send({ operation: 'search_by_id', schema: SCHEMA, table, ids: [id], get_attributes: ['id', 'bucket'] })
			.timeout(30_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return rows.length ? { id: String(rows[0].id), bucket: String(rows[0].bucket) } : null;
	}

	/** Full base-table scan via the custom Dump resource (index-independent). */
	async function dumpBase(dumpPath: string): Promise<Array<{ id: string; bucket: string; seq: number }>> {
		const r = await fetch(`${httpURL}${dumpPath}`, { headers: { Authorization: client.headers.Authorization } });
		strictEqual(r.status, 200, `${dumpPath} should return 200`);
		return (await r.json()) as Array<{ id: string; bucket: string; seq: number }>;
	}

	/**
	 * Consistency oracle for one (table, bucket). Returns the two defect classes plus counts.
	 *  phantom: index hit whose base row is absent (or has a different bucket).
	 *  missing: surviving base row of this bucket NOT returned by the index search.
	 */
	async function checkConsistency(table: string, dumpPath: string, bucket: string) {
		const indexHits = await searchByBucket(table, bucket);
		const base = await dumpBase(dumpPath);
		const baseOfBucket = new Set(base.filter((row) => row.bucket === bucket).map((row) => row.id));

		const phantom: string[] = [];
		for (const id of indexHits) {
			const rec = await getById(table, id);
			if (!rec || rec.bucket !== bucket) phantom.push(id);
		}
		const missing: string[] = [];
		for (const id of baseOfBucket) if (!indexHits.has(id)) missing.push(id);

		return { indexCount: indexHits.size, baseCount: baseOfBucket.size, phantom, missing };
	}

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
	test('Q1 mid-eviction: index/base stay consistent during the sweep', { timeout: 60_000 }, async () => {
		// expiration:4s, scanInterval:2s. Rows become evictable at ~t=4s after load; the sweep
		// fires every ~2s. Sample partway through the sweep (some evicted, some not) so a split
		// force-committed eviction would surface as a phantom/missing right here.
		await sleep(5_000);
		let totalPhantom = 0;
		let totalMissing = 0;
		let snapBase = 0;
		for (const bucket of EXPIRING_BUCKETS) {
			const r = await checkConsistency('Expiring', '/DumpE/', bucket);
			snapBase += r.baseCount;
			totalPhantom += r.phantom.length;
			totalMissing += r.missing.length;
			console.log(
				`[QA-179 Q1 ${ENGINE}] Expiring/${bucket} base=${r.baseCount} index=${r.indexCount} ` +
					`phantom=${r.phantom.length} missing=${r.missing.length}`
			);
		}
		const fired = sawOverTime();
		console.log(
			`\n[QA-179 Q1 ${ENGINE}] mid-eviction survivingExpiringBase=${snapBase} overTimeFired=${fired} ` +
				`count=${countOverTime()} totalPhantom=${totalPhantom} totalMissing=${totalMissing}\n` +
				`  >>> ${
					totalPhantom === 0 && totalMissing === 0
						? 'CONSISTENT mid-eviction (green anchor)'
						: `ORPHANED INDEX ENTRIES (DEFECT): ${totalPhantom} phantom + ${totalMissing} missing`
				}`
		);
		strictEqual(totalPhantom, 0, `mid-eviction phantom index entries: ${totalPhantom}`);
		strictEqual(totalMissing, 0, `mid-eviction missing index entries: ${totalMissing}`);
	});

	// ---- Q2: after settle — all expiring rows gone from BOTH base and index; control intact --
	test(
		'Q2 post-settle: expiring fully evicted (base+index), permanent fully retained',
		{ timeout: 90_000 },
		async () => {
			// Poll until the expiring base table drains to 0 (the eviction sweep has finished).
			const deadline = Date.now() + 60_000;
			let eBaseLen = -1;
			while (Date.now() < deadline) {
				const eBase = await dumpBase('/DumpE/');
				eBaseLen = eBase.length;
				if (eBaseLen === 0) break;
				await sleep(1_000);
			}

			// Base oracle: nothing left in the expiring table.
			strictEqual(eBaseLen, 0, `expiring base table should drain to 0 after eviction, got ${eBaseLen}`);

			// Index oracle: no surviving index entries pointing at evicted rows (phantom check).
			let totalPhantom = 0;
			let totalIndex = 0;
			for (const bucket of EXPIRING_BUCKETS) {
				const r = await checkConsistency('Expiring', '/DumpE/', bucket);
				totalIndex += r.indexCount;
				totalPhantom += r.phantom.length;
				console.log(
					`[QA-179 Q2 ${ENGINE}] Expiring/${bucket} base=${r.baseCount} index=${r.indexCount} phantom=${r.phantom.length}`
				);
			}

			// Control oracle: the non-expiring table is untouched AND fully indexed (missing check).
			const rP = await checkConsistency('Permanent', '/DumpP/', PERMANENT_BUCKET);

			const fired = sawOverTime();
			const otCount = countOverTime();
			// NOTE (F-041): on LMDB the over-time force-commit path is not reachable in a short sweep
			// (hardcoded 30s threshold); this tests plain-eviction index consistency. The transient
			// eviction phantom window for LMDB under force-commit remains an open known behavior (F-041).
			console.log(
				`\n[QA-179 Q2 ${ENGINE}] overTimeFired=${fired} overTimeCount=${otCount}\n` +
					`  expiring: residualBase=${eBaseLen} residualIndex=${totalIndex} phantom=${totalPhantom}\n` +
					`  permanent: base=${rP.baseCount} index=${rP.indexCount} phantom=${rP.phantom.length} missing=${rP.missing.length}\n` +
					`  >>> ${
						!fired
							? `INCONCLUSIVE (over-time never fired on ${ENGINE}) — reporting plain-eviction consistency`
							: totalIndex === 0 && totalPhantom === 0 && rP.missing.length === 0 && rP.phantom.length === 0
								? 'CONSISTENT under forced over-time eviction (green regression anchor)'
								: `DEFECT: residualIndex=${totalIndex} expiringPhantom=${totalPhantom} ` +
									`permMissing=${rP.missing.length} permPhantom=${rP.phantom.length}`
					}`
			);

			// Headline assertions — phantom: no index entry survives a fully-evicted expiring row.
			strictEqual(totalIndex, 0, `residual index entries for fully-evicted expiring table: ${totalIndex}`);
			strictEqual(totalPhantom, 0, `phantom index entries in expiring table: ${totalPhantom}`);
			// Control table must be perfectly consistent — proves the oracle and that the sweep is scoped.
			strictEqual(rP.baseCount, ROWS_PERMANENT, `permanent base rows should all survive: ${rP.baseCount}`);
			strictEqual(rP.missing.length, 0, `permanent missing index entries (base->no index): ${rP.missing.length}`);
			strictEqual(rP.phantom.length, 0, `permanent phantom index entries (index->no base): ${rP.phantom.length}`);
			// Soft signal: did the force-commit actually fire on this engine?
			ok(true, `over-time fired=${fired} count=${otCount}`);
		}
	);
});
