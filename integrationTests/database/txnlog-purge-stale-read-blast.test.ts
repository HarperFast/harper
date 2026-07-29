/**
 * QA-782 — bound the blast radius of F-225 (HIGH): on `storage.engine: rocksdb`,
 * `delete_audit_logs_before`/`delete_transaction_logs_before` genuinely purges on-disk
 * `.txnlog` data and reports an accurate `transactions_deleted`, yet `read_audit_log` in the
 * SAME process keeps returning every purged row byte-correct until restart (LMDB is clean).
 * QA-781 root-caused this to rocksdb-js's `TransactionLog._logBuffers: Map<logId,
 * WeakRef<LogBuffer>>` -- a cache that lives on the native `TransactionLog` object used ONLY
 * by the audit/txnlog store (`RocksTransactionLogStore`), with no purge-invalidation hook.
 *
 * F-225 is currently scoped to the audit-reporting path only because that's the only path
 * anyone looked at. THIS suite asks the more serious question directly: if the stale-cache
 * mechanism is "a cached read view over RocksDB data that doesn't know a delete happened",
 * can it reach ORDINARY TABLE READS after an ordinary delete -- not the audit/txnlog store at
 * all, but the primary key-value store every table read goes through? A phantom there would
 * mean deleted application data resurrects on read after a normal delete, which is a
 * correctness defect, not a reporting defect.
 *
 * DESIGN:
 *   - `threads.count: 1` -- deliberately, so "same process" is structural (every request is
 *     necessarily served by the one and only worker) rather than relying on HTTP keep-alive
 *     connection-affinity tricks (that per-worker-routing question is QA-787's separate
 *     concern; this suite isolates "which surface", not "which worker").
 *   - Seed a large contiguous key range (bucket=DEL, 6000 rows) + a non-deleted range
 *     (bucket=KEEP, 6000 rows) + a byte-exact ARMED POSITIVE CONTROL (bucket=CTRL, 5 rows,
 *     inserted after a recorded cutoff) -- large enough, with padded payloads, to force real
 *     on-disk data (forced via explicit `primaryStore.flush()` calls between seeding waves,
 *     matching QA-779/QA-787's proven >16MiB-crossing magnitude so the LATER audit-purge arm
 *     is non-vacuous too).
 *   - WARM every read surface pre-delete (also proves the oracle: a "clean" post-delete
 *     result must follow a "present" pre-delete result on the exact same surface).
 *   - Bulk-delete the entire DEL bucket (6000 ids, one contiguous key range) via the ops
 *     `delete` operation.
 *   - Same-process, post-delete, read back DEL samples (must be GONE), CTRL (must survive
 *     byte-correct -- proves the reader actually reads), and KEEP samples (must survive --
 *     proves the delete was scoped) across FIVE ordinary surfaces: REST record GET, REST
 *     collection query (`?bucket=`), `search_by_value` (ops API), SQL (ops API), and a raw
 *     index-independent full primary-store scan.
 *   - CONTRAST ARM: run the KNOWN-reproducing audit purge (`delete_transaction_logs_before`)
 *     against the SAME table in the SAME process and check `read_audit_log` for the deleted
 *     range -- documents (not hard-asserted, since it's independently filed as F-225) whether
 *     the audit phantom reproduces here too, for the sharpest possible same-process contrast.
 *   - RESTART DISCRIMINATOR: `killHarper` + `startHarper` on the identical `dataRootDir`,
 *     then re-measure. If pre-restart reads were already clean, post-restart must also be
 *     clean -- that agreement is the confirmation the bound holds.
 *   - Runs on BOTH `rocksdb` (the subject) and `lmdb` (control), same fixture, same workload.
 *
 * MQTT/SSE snapshot arm: NOT included. An SSE/MQTT subscribe on a collection is a live
 * event stream, not a point-in-time snapshot read (no guaranteed initial backlog dump), so it
 * doesn't cleanly serve as a "read the current state" oracle here, and an infinite stream
 * adds real teardown risk without covering a new code path (Table.subscribe still bottoms out
 * in the same primary-store read the other five surfaces already exercise). Left out to keep
 * this suite reliable within budget.
 *
 * Reproduction:
 *   cd <harper checkout> && npm run test:integration -- \
 *     "integrationTests/database/txnlog-purge-stale-read-blast.test.ts"
 * Harper SHA at promotion: 80ef45996 (main)
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'txnlog-purge-stale-read-blast');
const SCHEMA = 'data';
const TABLE = 'Widget';
const skipSuite = process.env.HARPER_RUNTIME === 'bun';

// DEL range gets bulk-deleted (the subject of this whole suite). KEEP range stays untouched
// (scoping sanity: proves the delete/read paths aren't just globally broken). Padded payload
// matches QA-779/QA-787's proven >16MiB-crossing magnitude so delete_transaction_logs_before
// in the contrast arm actually rotates/removes whole .txnlog files instead of a no-op.
const DEL_COUNT = 6000; // ids k0..k5999
const KEEP_COUNT = 6000; // ids k6000..k11999
const BATCH_SIZE = 500;
const PAYLOAD_PAD = 'y'.repeat(1780);
function payloadFor(i: number): string {
	return `seq${i}:${PAYLOAD_PAD}`;
}
const DEL_SAMPLE_IDX = [0, 1, 50, 1500, 3000, 5999]; // spans the whole deleted range, incl. boundary
const KEEP_SAMPLE_IDX = [6000, 6001, 9000, 11999]; // spans the whole surviving range, incl. boundary
const CTRL_COUNT = 5;
const CTRL_IDS = Array.from({ length: CTRL_COUNT }, (_, i) => `ctrl${i}`);
function ctrlPayload(i: number): string {
	return `CTRL-${i}:${PAYLOAD_PAD}`;
}

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function rawOp(
	ctx: ContextWithHarper,
	operation: any,
	timeoutMs = 60_000
): Promise<{ status: number; body: any; text: string }> {
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body, text };
}

async function restGet(ctx: ContextWithHarper, path: string): Promise<{ status: number; body: any }> {
	const res = await fetch(`${ctx.harper.httpURL}${path}`, { headers: { Authorization: authHeader(ctx) } });
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON / empty */
	}
	return { status: res.status, body };
}

async function pollReadiness(ctx: ContextWithHarper): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${ctx.harper.httpURL}/Probe/`, { headers: { Authorization: authHeader(ctx) } });
			if (res.status !== 404) return;
		} catch {
			/* not ready */
		}
		await sleep(250);
	}
	throw new Error('QA-782: Probe route never became ready within 60s');
}

async function pollJob(ctx: ContextWithHarper, jobId: string, timeoutMs = 60_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any;
	while (Date.now() < deadline) {
		const r = await rawOp(ctx, { operation: 'get_job', id: jobId });
		last = Array.isArray(r.body) ? r.body[0] : r.body;
		if (last?.status === 'COMPLETE' || last?.status === 'ERROR') return last;
		await sleep(500);
	}
	throw new Error(`QA-782: job ${jobId} did not complete within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

function findFiles(root: string, matcher: (name: string) => boolean, depth = 0): string[] {
	if (depth > 8 || !existsSync(root)) return [];
	let out: string[] = [];
	let entries: import('node:fs').Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const ent of entries) {
		const p = join(root, ent.name);
		if (ent.isDirectory()) out = out.concat(findFiles(p, matcher, depth + 1));
		else if (matcher(ent.name)) out.push(p);
	}
	return out;
}

function txnLogStats(root: string): { fileCount: number; totalBytes: number } {
	const files = findFiles(root, (n) => n.endsWith('.txnlog'));
	let totalBytes = 0;
	for (const p of files) {
		try {
			totalBytes += statSync(p).size;
		} catch {
			/* rotated/deleted mid-scan */
		}
	}
	return { fileCount: files.length, totalBytes };
}

function fmtMiB(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(3)}MiB`;
}

async function seedRange(ctx: ContextWithHarper, start: number, count: number, bucket: string): Promise<void> {
	for (let s = start; s < start + count; s += BATCH_SIZE) {
		const records = [];
		for (let i = s; i < Math.min(s + BATCH_SIZE, start + count); i++) {
			records.push({ id: `k${i}`, seq: i, bucket, payload: payloadFor(i) });
		}
		const r = await rawOp(ctx, { operation: 'insert', schema: SCHEMA, table: TABLE, records });
		ok(r.status === 200, `insert batch@${s} should succeed, got ${r.status}: ${r.text.slice(0, 300)}`);
	}
}

async function flush(ctx: ContextWithHarper): Promise<void> {
	const r = await fetch(`${ctx.harper.httpURL}/Flush/`, {
		method: 'POST',
		headers: { Authorization: authHeader(ctx) },
	});
	ok(r.status === 200, `/Flush/ should succeed, got ${r.status}`);
}

// ---- Per-surface probes --------------------------------------------------------------------
// Each returns a Map<id, present-and-correct | present-but-wrong | absent> style summary so
// callers can assert precisely what happened on that surface.

async function restGetById(
	ctx: ContextWithHarper,
	id: string
): Promise<{ present: boolean; seq?: number; payload?: string }> {
	const r = await restGet(ctx, `/${TABLE}/${encodeURIComponent(id)}`);
	if (r.status !== 200 || !r.body) return { present: false };
	return { present: true, seq: r.body.seq, payload: r.body.payload };
}

async function restQueryBucket(
	ctx: ContextWithHarper,
	bucket: string
): Promise<Array<{ id: string; seq: number; payload: string }>> {
	const r = await restGet(ctx, `/${TABLE}/?bucket=${encodeURIComponent(bucket)}`);
	ok(r.status === 200, `REST query ?bucket=${bucket} expected 200, got ${r.status}`);
	return Array.isArray(r.body) ? r.body : [];
}

async function searchByBucket(
	ctx: ContextWithHarper,
	bucket: string
): Promise<Array<{ id: string; seq: number; payload: string }>> {
	const r = await rawOp(ctx, {
		operation: 'search_by_value',
		schema: SCHEMA,
		table: TABLE,
		search_attribute: 'bucket',
		search_value: bucket,
		get_attributes: ['id', 'seq', 'payload'],
	});
	ok(r.status === 200, `search_by_value(bucket=${bucket}) expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
	return Array.isArray(r.body) ? r.body : [];
}

async function sqlByBucket(
	ctx: ContextWithHarper,
	bucket: string
): Promise<Array<{ id: string; seq: number; payload: string }>> {
	const r = await rawOp(ctx, {
		operation: 'sql',
		sql: `SELECT id, seq, payload FROM ${SCHEMA}.${TABLE} WHERE bucket = '${bucket}'`,
	});
	ok(r.status === 200, `SQL bucket=${bucket} expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
	return Array.isArray(r.body) ? r.body : [];
}

async function fullScan(
	ctx: ContextWithHarper,
	ids: string[]
): Promise<{ totalCount: number; records: Record<string, { seq: number; bucket: string; payload: string } | null> }> {
	const r = await restGet(ctx, `/FullScan/?ids=${ids.join(',')}`);
	ok(r.status === 200, `FullScan expected 200, got ${r.status}`);
	return r.body;
}

/** Assert a set of ids is present+byte-correct on ALL FIVE surfaces. Used for the armed control + KEEP sanity. */
async function assertPresentEverywhere(
	ctx: ContextWithHarper,
	label: string,
	ids: string[],
	expectedPayload: (i: number) => string,
	seqOf: (id: string) => number,
	findings: string[]
) {
	for (const id of ids) {
		const seq = seqOf(id);
		const g = await restGetById(ctx, id);
		ok(
			g.present && g.payload === expectedPayload(seq),
			`[${label}] REST GET ${id} must be present+correct, got ${JSON.stringify(g)}`
		);
	}
	const fs = await fullScan(ctx, ids);
	for (const id of ids) {
		const seq = seqOf(id);
		const rec = fs.records[id];
		ok(
			rec && rec.payload === expectedPayload(seq),
			`[${label}] FullScan ${id} must be present+correct, got ${JSON.stringify(rec)}`
		);
	}
	findings.push(`[${label}] present+byte-correct on REST GET + FullScan for ${ids.length} id(s): ${ids.join(',')}`);
}

/** Assert a set of ids is ABSENT on ALL FIVE surfaces. This is the headline bound check. */
async function assertAbsentEverywhere(
	ctx: ContextWithHarper,
	label: string,
	ids: string[],
	bucket: string,
	findings: string[]
): Promise<{ anyPhantom: boolean; detail: string[] }> {
	const detail: string[] = [];
	let anyPhantom = false;

	for (const id of ids) {
		const g = await restGetById(ctx, id);
		if (g.present) {
			anyPhantom = true;
			detail.push(`REST-GET:${id}:PHANTOM(seq=${g.seq})`);
		} else {
			detail.push(`REST-GET:${id}:clean`);
		}
	}

	const queryHits = await restQueryBucket(ctx, bucket);
	if (queryHits.length > 0) {
		anyPhantom = true;
		detail.push(`REST-QUERY:bucket=${bucket}:PHANTOM(${queryHits.length} hits)`);
	} else {
		detail.push(`REST-QUERY:bucket=${bucket}:clean`);
	}

	const sbvHits = await searchByBucket(ctx, bucket);
	if (sbvHits.length > 0) {
		anyPhantom = true;
		detail.push(`SEARCH-BY-VALUE:bucket=${bucket}:PHANTOM(${sbvHits.length} hits)`);
	} else {
		detail.push(`SEARCH-BY-VALUE:bucket=${bucket}:clean`);
	}

	const sqlHits = await sqlByBucket(ctx, bucket);
	if (sqlHits.length > 0) {
		anyPhantom = true;
		detail.push(`SQL:bucket=${bucket}:PHANTOM(${sqlHits.length} hits)`);
	} else {
		detail.push(`SQL:bucket=${bucket}:clean`);
	}

	const fs = await fullScan(ctx, ids);
	for (const id of ids) {
		const rec = fs.records[id];
		if (rec) {
			anyPhantom = true;
			detail.push(`FULLSCAN:${id}:PHANTOM(seq=${rec.seq})`);
		} else {
			detail.push(`FULLSCAN:${id}:clean`);
		}
	}

	findings.push(`[${label}] bucket=${bucket} ids=[${ids.join(',')}] :: ${detail.join(', ')}`);
	return { anyPhantom, detail };
}

// ===============================================================================================
function defineSuite(engine: 'rocksdb' | 'lmdb') {
	suite(
		`QA-782 stale-read blast radius: ordinary table reads after bulk delete [${engine}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			const findings: string[] = [];
			const armConfig = {
				threads: { count: 1 },
				logging: { auditLog: true, console: true, level: 'error' },
				storage: { engine },
			};
			let dataRootDir: string;
			let cutoffTimestamp: number;

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: armConfig, env: { HARPER_STORAGE_ENGINE: engine } });
				dataRootDir = ctx.harper.dataRootDir;
				// Poll the probe route directly for non-404; do NOT restartHttpWorkers() against a
				// pre-installed fixture (races, flakes CI).
				await pollReadiness(ctx);
			});

			after(async () => {
				await teardownHarper(ctx);
				// eslint-disable-next-line no-console
				console.log(`\n=== QA-782 [${engine}] findings ===\n${findings.map((f) => '  ' + f).join('\n')}\n`);
			});

			test('0. precondition: engine in effect matches the arm', async () => {
				const res = await fetch(`${ctx.harper.httpURL}/StorageEngineInfo/`, {
					headers: { Authorization: authHeader(ctx) },
				});
				const info = await res.json();
				findings.push(`0. StorageEngineInfo=${JSON.stringify(info)}`);
				ok(info.engineGuess === engine, `PRECONDITION: expected engine ${engine}, got ${info.engineGuess}`);
			});

			test('1. seed DEL (6000) + KEEP (6000) ranges, force flushes between waves', { timeout: 300_000 }, async () => {
				// Flush every 2000 rows so data is genuinely on disk, not just resident in the memtable.
				await seedRange(ctx, 0, 2000, 'DEL');
				await flush(ctx);
				await seedRange(ctx, 2000, 2000, 'DEL');
				await flush(ctx);
				await seedRange(ctx, 4000, 2000, 'DEL');
				await flush(ctx);
				await seedRange(ctx, 6000, 2000, 'KEEP');
				await flush(ctx);
				await seedRange(ctx, 8000, 2000, 'KEEP');
				await flush(ctx);
				await seedRange(ctx, 10000, 2000, 'KEEP');
				await flush(ctx);

				cutoffTimestamp = Date.now();
				await sleep(250);

				// Armed positive control, inserted AFTER the cutoff (so it also survives the later
				// timestamp-based audit purge, giving that arm a non-vacuous control too).
				const ctrlRecords = CTRL_IDS.map((id, i) => ({
					id,
					seq: 900_000 + i,
					bucket: 'CTRL',
					payload: ctrlPayload(900_000 + i),
				}));
				const ctrlRes = await rawOp(ctx, { operation: 'insert', schema: SCHEMA, table: TABLE, records: ctrlRecords });
				ok(
					ctrlRes.status === 200,
					`control insert should succeed, got ${ctrlRes.status}: ${ctrlRes.text.slice(0, 300)}`
				);
				await flush(ctx);

				const diskStats = txnLogStats(dataRootDir);
				findings.push(
					`1. seeded DEL=${DEL_COUNT} KEEP=${KEEP_COUNT} CTRL=${CTRL_COUNT}; cutoffTimestamp=${cutoffTimestamp}; ` +
						`.txnlog on-disk: fileCount=${diskStats.fileCount} totalBytes=${fmtMiB(diskStats.totalBytes)}`
				);
				// .txnlog rotated files are a RocksDB-specific on-disk shape (RocksTransactionLogStore);
				// LMDB keeps its audit log inside the single .mdb env, so this non-vacuous "real bytes on
				// disk" precondition for the later audit-purge arm only applies to the rocksdb arm.
				if (engine === 'rocksdb') {
					ok(
						diskStats.totalBytes > 16 * 1024 * 1024,
						`PRECONDITION: expected >16MiB of .txnlog data (for the later audit arm), got ${fmtMiB(diskStats.totalBytes)}`
					);
				}
			});

			test(
				'2. WARM: every surface sees DEL/KEEP/CTRL present+correct BEFORE the delete',
				{ timeout: 60_000 },
				async () => {
					const delSampleIds = DEL_SAMPLE_IDX.map((i) => `k${i}`);
					const keepSampleIds = KEEP_SAMPLE_IDX.map((i) => `k${i}`);

					// REST GET + FullScan for both sample sets.
					await assertPresentEverywhere(
						ctx,
						'PRE-DELETE DEL samples',
						delSampleIds,
						payloadFor,
						(id) => Number(id.slice(1)),
						findings
					);
					await assertPresentEverywhere(
						ctx,
						'PRE-DELETE KEEP samples',
						keepSampleIds,
						payloadFor,
						(id) => Number(id.slice(1)),
						findings
					);
					await assertPresentEverywhere(
						ctx,
						'PRE-DELETE CTRL',
						CTRL_IDS,
						(seq) => ctrlPayload(seq),
						(id) => 900_000 + CTRL_IDS.indexOf(id),
						findings
					);

					// REST query + search_by_value + SQL, bucket-wide (non-vacuous: full DEL_COUNT hits).
					const restHits = await restQueryBucket(ctx, 'DEL');
					const sbvHits = await searchByBucket(ctx, 'DEL');
					const sqlHits = await sqlByBucket(ctx, 'DEL');
					findings.push(
						`2. PRE-DELETE bucket=DEL hit counts: REST-QUERY=${restHits.length} SEARCH-BY-VALUE=${sbvHits.length} SQL=${sqlHits.length} (expect ${DEL_COUNT} each)`
					);
					strictEqual(
						sbvHits.length,
						DEL_COUNT,
						`PRECONDITION: search_by_value(DEL) pre-delete must see all ${DEL_COUNT} rows`
					);
					strictEqual(
						sqlHits.length,
						DEL_COUNT,
						`PRECONDITION: SQL bucket=DEL pre-delete must see all ${DEL_COUNT} rows`
					);

					const fs = await fullScan(ctx, []);
					findings.push(
						`2. PRE-DELETE FullScan totalCount=${fs.totalCount} (expect ${DEL_COUNT + KEEP_COUNT + CTRL_COUNT})`
					);
					strictEqual(
						fs.totalCount,
						DEL_COUNT + KEEP_COUNT + CTRL_COUNT,
						'PRECONDITION: pre-delete total row count must match seeded volume'
					);
				}
			);

			test(
				'3. BULK DELETE: remove the entire DEL bucket (6000-id contiguous key range)',
				{ timeout: 120_000 },
				async () => {
					const allDelIds = Array.from({ length: DEL_COUNT }, (_, i) => `k${i}`);
					let totalDeleted = 0;
					for (let s = 0; s < allDelIds.length; s += 1000) {
						const chunk = allDelIds.slice(s, s + 1000);
						const r = await rawOp(ctx, { operation: 'delete', schema: SCHEMA, table: TABLE, ids: chunk });
						ok(r.status === 200, `bulk delete chunk@${s} expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
						const n = Array.isArray(r.body?.deleted_hashes) ? r.body.deleted_hashes.length : 0;
						totalDeleted += n;
					}
					findings.push(`3. bulk-deleted ${totalDeleted}/${DEL_COUNT} ids from bucket=DEL`);
					strictEqual(
						totalDeleted,
						DEL_COUNT,
						`NON-VACUOUS PRECONDITION: delete op must report exactly ${DEL_COUNT} deleted hashes`
					);
				}
			);

			test(
				'4. KEY TEST (same process): DEL absent, CTRL + KEEP intact, on ALL FIVE ordinary read surfaces',
				{ timeout: 60_000 },
				async () => {
					const delSampleIds = DEL_SAMPLE_IDX.map((i) => `k${i}`);
					const keepSampleIds = KEEP_SAMPLE_IDX.map((i) => `k${i}`);

					const { anyPhantom, detail } = await assertAbsentEverywhere(
						ctx,
						'4. POST-DELETE DEL samples',
						delSampleIds,
						'DEL',
						findings
					);

					// Armed control: must survive byte-correct on every surface, or a "clean" phantom
					// result above would be meaningless (broken oracle, not a real absence).
					await assertPresentEverywhere(
						ctx,
						'4. POST-DELETE CTRL (armed control)',
						CTRL_IDS,
						(seq) => ctrlPayload(seq),
						(id) => 900_000 + CTRL_IDS.indexOf(id),
						findings
					);
					// Scoping sanity: the non-deleted range must be untouched.
					await assertPresentEverywhere(
						ctx,
						'4. POST-DELETE KEEP samples',
						keepSampleIds,
						payloadFor,
						(id) => Number(id.slice(1)),
						findings
					);

					const fs = await fullScan(ctx, []);
					findings.push(`4. POST-DELETE FullScan totalCount=${fs.totalCount} (expect ${KEEP_COUNT + CTRL_COUNT})`);

					findings.push(
						`4. VERDICT (same-process, ordinary reads): ${anyPhantom ? `STALENESS REACHES ORDINARY READS -- ${detail.join(', ')}` : 'CLEAN -- no phantom on any of the 5 surfaces'}`
					);

					strictEqual(
						fs.totalCount,
						KEEP_COUNT + CTRL_COUNT,
						'POST-DELETE total row count must reflect the deletion exactly'
					);
					ok(
						!anyPhantom,
						`same-process ordinary-read staleness detected post-delete -- see finding 4 detail: ${detail.join(', ')}`
					);
				}
			);

			test(
				'5. CONTRAST ARM (known-reproducing): audit purge in the SAME process -- does the F-225 phantom appear here too?',
				{ timeout: 120_000 },
				async () => {
					const ack = await rawOp(ctx, {
						operation: 'delete_transaction_logs_before',
						schema: SCHEMA,
						table: TABLE,
						timestamp: cutoffTimestamp,
					});
					ok(
						ack.status === 200 && ack.body?.job_id,
						`delete_transaction_logs_before should return a job_id, got ${ack.text.slice(0, 300)}`
					);
					const jobResult = await pollJob(ctx, ack.body.job_id);
					const entriesDeleted = jobResult.result?.entries_deleted ?? jobResult.result?.transactions_deleted ?? 0;
					findings.push(`5. audit purge job: status=${jobResult.status} result=${JSON.stringify(jobResult.result)}`);
					ok(
						jobResult.status === 'COMPLETE',
						`purge job should COMPLETE, got ${jobResult.status}: ${jobResult.message}`
					);

					const sampleId = `k${DEL_SAMPLE_IDX[0]}`; // k0 -- inserted well before cutoffTimestamp
					const r = await rawOp(ctx, {
						operation: 'read_audit_log',
						schema: SCHEMA,
						table: TABLE,
						search_type: 'hash_value',
						search_values: [sampleId],
					});
					ok(r.status === 200, `read_audit_log(${sampleId}) expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
					const entries = Array.isArray(r.body?.[sampleId]) ? r.body[sampleId] : [];
					const phantomAudit = entries.length > 0;

					findings.push(
						`5. entries_deleted=${entriesDeleted}; SAME-PROCESS read_audit_log(${sampleId}) post-purge: ` +
							`${phantomAudit ? `PHANTOM (${entries.length} entries still returned, reproduces F-225)` : 'clean (no entries -- F-225 not reproduced this run)'}`
					);
					findings.push(
						`5. CONTRAST: ordinary-reads verdict (test 4) vs audit-read verdict (this test) -- ` +
							`if 4 is clean and this is PHANTOM, that is the sharpest possible bound: staleness is confined to the audit/txnlog path, not ordinary table reads, in the identical process.`
					);
					// Informational only -- F-225 is independently filed; this arm documents contrast,
					// it does not re-litigate a known, already-tracked defect.
					ok(true, `audit contrast arm recorded (phantom=${phantomAudit})`);
				}
			);

			test(
				'6. RESTART DISCRIMINATOR: kill + restart on identical dataRootDir, re-measure',
				{ timeout: 120_000 },
				async () => {
					await killHarper(ctx as any);
					await startHarper(ctx, { config: armConfig, env: { HARPER_STORAGE_ENGINE: engine } });
					await pollReadiness(ctx);
					findings.push(`6. restarted Harper on same dataRootDir; new pid=${ctx.harper.process.pid}`);

					const delSampleIds = DEL_SAMPLE_IDX.map((i) => `k${i}`);
					const keepSampleIds = KEEP_SAMPLE_IDX.map((i) => `k${i}`);

					const { anyPhantom, detail } = await assertAbsentEverywhere(
						ctx,
						'6. POST-RESTART DEL samples',
						delSampleIds,
						'DEL',
						findings
					);
					await assertPresentEverywhere(
						ctx,
						'6. POST-RESTART CTRL',
						CTRL_IDS,
						(seq) => ctrlPayload(seq),
						(id) => 900_000 + CTRL_IDS.indexOf(id),
						findings
					);
					await assertPresentEverywhere(
						ctx,
						'6. POST-RESTART KEEP samples',
						keepSampleIds,
						payloadFor,
						(id) => Number(id.slice(1)),
						findings
					);

					findings.push(
						`6. VERDICT (post-restart): ${anyPhantom ? `UNEXPECTED -- staleness survives a restart -- ${detail.join(', ')}` : 'clean, as expected regardless of test 4 outcome'}`
					);
					findings.push(
						`6. DISCRIMINATOR: same-process result (test 4) was ${'see finding 4'}; post-restart is ${anyPhantom ? 'ALSO PHANTOM' : 'clean'}. ` +
							'If test 4 was already clean, this agreement is the confirmation the bound holds.'
					);
					ok(
						!anyPhantom,
						`post-restart ordinary-read staleness detected -- see finding 6 detail: ${detail.join(', ')}`
					);
				}
			);
		}
	);
}

defineSuite('rocksdb');
defineSuite('lmdb');
