/**
 * QA-725 (source:gh:1939) — HarperFast/harper#1939 reports a flaky unit test:
 * unitTests/resources/auditLog.test.js "check log after writes and prune", failing on
 * `assert(events.length > 2, 'Should have at least a couple of update events')` (line 56).
 *
 * Reading that unit test closely: the flaky assertion is on the SUBSCRIBE event stream
 * (`AuditedTable.subscribe({}).on('data', ...)`) sampled after a fixed `delay(20)` — not
 * on the persisted audit log itself. The persisted-log assertion a few lines earlier
 * (`results.length === 4` from `getHistory()`) is synchronous and NOT what the issue
 * reports failing. That is the working hypothesis this experiment tests directly: is
 * there a real audit-log defect (loss / reordering / prune destroying live entries), or
 * is the flake purely about event-delivery timing racing a fixed 20ms sleep under CI load
 * (a class already named in the issue: "a family of margin-sensitive unit tests worth a
 * shared fix pattern")?
 *
 * This experiment does NOT re-run the flaky unit test. It probes the underlying
 * invariants at the ops-API / persisted-audit-log level, which is timing-independent of
 * any in-process EventEmitter delivery:
 *   Q1 — burst creates+updates+deletes: every update produces exactly one audit entry,
 *        entries are ordered by timestamp, none are lost (read via read_audit_log
 *        search_type=hash_value, which reads resources/Table.ts getHistoryOfRecord()).
 *   Q2 — prune boundary: delete_transaction_logs_before (ResourceBridge.
 *        deleteTransactionLogsBefore) removes only entries strictly before the cutoff;
 *        entries written after the cutoff must survive intact, verified by re-reading the
 *        audit log directly (not by trusting the reported deleted-count).
 *   Q3 — concurrent seam: fire the prune call and a fresh burst of writes without
 *        sequencing them (the exact "writes landing concurrently with a prune pass"
 *        scenario named in the assignment) and confirm the fresh, definitely-in-window
 *        writes are never destroyed.
 *   Both threads:{count:1} and threads:{count:4}.
 *
 * ARMED ORACLE: before trusting any "no loss" / "correctly pruned" result, test A
 * deliberately prunes a single known record's ENTIRE history, then (1) asserts a
 * knowingly-WRONG expected length inside a try/catch and confirms assert.strictEqual
 * actually throws AssertionError, then (2) asserts the real (correct) length. This
 * proves the oracle detects genuine deletion rather than being vacuously true (e.g. from
 * read_audit_log silently ignoring the prune or always returning cached data).
 *
 * QA-730 (this revision) — engine split discovered after a wave went 4/8 red on the same
 * SHA that previously went 8/8 green. Root cause: the harness/build default storage
 * engine is RocksDB (resources/databases.ts: `useRocksdb = (HARPER_STORAGE_ENGINE ||
 * storage_engine config) !== 'lmdb'`), and this spec never pinned an engine, so it silently
 * inherits whichever default the build/environment happened to select. On RocksDB,
 * `delete_transaction_logs_before` -> ResourceBridge.deleteTransactionLogsBefore ->
 * `primaryStore.purgeLogs({before})` (dataLayer/harperBridge/ResourceBridge.ts ~L480) can
 * only remove a transaction-log FILE when BOTH gates clear (rocksdb-js
 * transaction_log_store.cpp TransactionLogStore::doPurge):
 *   1. the file's own last-write-time is older than `before` (the currently-active file's
 *      mtime advances on every write, so this is only true once the file has ROTATED OUT —
 *      rotation triggers at a 16MB soft max file size or an 18h max-age heuristic; note this
 *      rotation/retention period is @harperfast/rocksdb-js's own native default and is NOT
 *      wired to Harper's `logging.auditRetention` config value — `rootDatabase.useLog('local')`
 *      in resources/RocksTransactionLogStore.ts is called with no options), AND
 *   2. every entry in that file has already been flushed from RocksDB's active memtable to
 *      an SST file (the `lastFlushedPosition` check) — which in turn requires RocksDB's own
 *      memtable-flush threshold (a fraction of available system memory via
 *      utility/rocksMemoryConfig.ts, easily 100s of MB) to have been crossed.
 * Neither gate is reachable in a short-lived, low-volume test process, so on RocksDB this
 * op legitimately no-ops (`entries_deleted: 0, log_files_deleted: 0`) while still returning
 * HTTP 200 / job status COMPLETE — a silent-looking no-op with no other signal, though not
 * itself a correctness bug (nothing that should survive is destroyed, and nothing already
 * "prunable" is retained — the data just never becomes prunable in this harness). On LMDB,
 * `Table.deleteHistory()` (resources/Table.ts ~L4703) deletes individual audit entries
 * directly and is unaffected by any of this. Confirmed via a temporary probe script:
 * `get_configuration` + on-disk file shape (RocksDB: LOG/MANIFEST/OPTIONS/CURRENT/IDENTITY;
 * LMDB: data.mdb) show today's red run used RocksDB (the default), and re-running with
 * `storage: { engine: 'lmdb' }` pinned goes 8/8 green with real per-entry deletion counts
 * (`entries_deleted: 160` for Q2's 8x20 old entries across both thread-count suites).
 * So: per-engine expectations below for the two prune-boundary assertions (armed oracle,
 * Q2); Q1/Q3 (no-loss / ordering / concurrent-write-survival) do not depend on engine and
 * are unchanged (they already passed on both engines).
 *
 * Harper SHA: b8c843a24a4b2b3f002a2b786415333fd7f3b597
 * Repro:
 *   cd /home/kzyp/dev/harper && timeout 900 npm run test:integration -- \
 *     "integrationTests/qa-scratch/qa725-audit-prune.test.ts" > /home/kzyp/dev/tmp/qa725.log 2>&1
 *   (LMDB arm: HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- \
 *     "integrationTests/qa-scratch/qa725-audit-prune.test.ts")
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, AssertionError } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-log-completeness-prune');
const SCHEMA = 'data';
const TABLE = 'Item';
const skipSuite = process.platform === 'win32';

// Pin the engine explicitly (default rocksdb, matching the repo-wide HARPER_STORAGE_ENGINE
// convention used by other qa-scratch/database specs) so this spec's behavior is
// deterministic instead of silently inheriting whatever the harness/build defaults to.
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

// Short so the boundary tests don't need to wait long, but long enough that our explicit
// cutoff timestamps land unambiguously on one side or the other.
const AUDIT_RETENTION_SECONDS = 5;

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function rawOp(ctx: ContextWithHarper, operation: any): Promise<{ status: number; body: any }> {
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify(operation),
	});
	const text = await res.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body };
}

/** read_audit_log / hash_value -> resources/Table.ts getHistoryOfRecord() per id. */
async function readHistories(ctx: ContextWithHarper, ids: string[]): Promise<Record<string, any[]>> {
	const r = await rawOp(ctx, {
		operation: 'read_audit_log',
		schema: SCHEMA,
		table: TABLE,
		search_type: 'hash_value',
		search_values: ids,
	});
	ok(r.status === 200, `read_audit_log expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
	return r.body as Record<string, any[]>;
}

/**
 * delete_transaction_logs_before -> ResourceBridge.deleteTransactionLogsBefore (modern,
 * non-deprecated op). IMPORTANT: this op is dispatched through the async job queue
 * (server/jobs/jobRunner.ts JOB_TYPE_ENUM.delete_transaction_logs_before) — the HTTP
 * response is just `{createdJob: {id, status: 'CREATED', ...}}`, returned before the
 * prune has actually run. Callers that read audit state immediately after this resolves
 * without polling get_job will race the prune (this bit our own first draft: the
 * "armed oracle" assertion observed the pre-prune entry count because the job hadn't
 * executed yet). We poll get_job to a terminal status before trusting any downstream read.
 */
async function pruneBefore(ctx: ContextWithHarper, timestamp: number): Promise<{ status: number; body: any }> {
	const submitted = await rawOp(ctx, {
		operation: 'delete_transaction_logs_before',
		schema: SCHEMA,
		table: TABLE,
		timestamp,
	});
	ok(
		submitted.status === 200,
		`delete_transaction_logs_before submit expected 200, got ${submitted.status}: ${JSON.stringify(submitted.body)}`
	);
	const jobId = submitted.body?.createdJob?.id ?? submitted.body?.job_id;
	ok(jobId, `delete_transaction_logs_before did not return a job id: ${JSON.stringify(submitted.body)}`);

	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const r = await rawOp(ctx, { operation: 'get_job', id: jobId });
		const job = Array.isArray(r.body) ? r.body[0] : r.body;
		if (job?.status === 'COMPLETE' || job?.status === 'ERROR') {
			ok(job.status === 'COMPLETE', `delete_transaction_logs_before job ended in ERROR: ${JSON.stringify(job)}`);
			return { status: 200, body: job };
		}
		await sleep(100);
	}
	throw new Error(`delete_transaction_logs_before job ${jobId} did not reach terminal status within 30s`);
}

async function insert(ctx: ContextWithHarper, records: any[]): Promise<void> {
	const r = await rawOp(ctx, { operation: 'insert', schema: SCHEMA, table: TABLE, records });
	ok(r.status === 200, `insert expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
}
async function update(ctx: ContextWithHarper, records: any[]): Promise<void> {
	const r = await rawOp(ctx, { operation: 'update', schema: SCHEMA, table: TABLE, records });
	ok(r.status === 200, `update expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
}
async function del(ctx: ContextWithHarper, ids: string[]): Promise<void> {
	const r = await rawOp(ctx, { operation: 'delete', schema: SCHEMA, table: TABLE, ids });
	ok(r.status === 200, `delete expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
}

/** Burst: insert N ids, 2 rounds of update, delete the even-indexed half. */
async function burst(ctx: ContextWithHarper, prefix: string, count: number) {
	const ids = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
	await insert(
		ctx,
		ids.map((id) => ({ id, seq: 0, val: 'v0' }))
	);
	await update(
		ctx,
		ids.map((id) => ({ id, seq: 1, val: 'v1' }))
	);
	await update(
		ctx,
		ids.map((id) => ({ id, seq: 2, val: 'v2' }))
	);
	const deletedIds = ids.filter((_, i) => i % 2 === 0);
	await del(ctx, deletedIds);
	return { ids, deletedIds };
}

function opOf(entry: any): string {
	// ResourceBridge.readAuditLog maps internal 'put' -> 'upsert'; normalize back for readability.
	return entry.operation;
}

function defineSuite(threadCount: number, engineOverride?: 'lmdb' | 'rocksdb') {
	const engine = engineOverride ?? ENGINE;
	suite(
		`QA-725 audit log invariants under writes+prune [threads=${threadCount}, engine=${engine}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: {
						threads: { count: threadCount },
						logging: { auditLog: true, auditRetention: AUDIT_RETENTION_SECONDS },
						storage: { engine },
					},
					env: {},
				});
				// Poll the probe route directly until it stops 404-ing (fixture is pre-installed;
				// do NOT call restartHttpWorkers() here, it races against a pre-installed fixture).
				const deadline = Date.now() + 60_000;
				while (Date.now() < deadline) {
					try {
						const res = await fetch(`${ctx.harper.httpURL}/${TABLE}/`, { headers: { Authorization: authHeader(ctx) } });
						if (res.status !== 404) break;
					} catch {
						/* not ready */
					}
					await sleep(250);
				}
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			// ---- Armed oracle -------------------------------------------------------------------
			// Per-engine expectation: LMDB deletes the matching entry directly (Table.deleteHistory),
			// so it is genuinely gone (expected 0). RocksDB's purgeLogs({before}) only removes whole
			// transaction-log FILES, and only once the file has both rotated out of active-write
			// status (mtime gate) and been flushed from RocksDB's memtable to an SST
			// (lastFlushedPosition gate) -- neither happens for one entry in a short test process, so
			// the entry legitimately survives (expected 1). See header comment for the full mechanism.
			test('A: armed oracle — prune genuinely destroys a known entry, and the assertion fires', async () => {
				const id = `armed-${threadCount}`;
				await insert(ctx, [{ id, seq: 0, val: 'v0' }]);
				const before = await readHistories(ctx, [id]);
				ok(
					before[id]?.length >= 1,
					`sanity: ${id} should have at least 1 audit entry before prune, got ${before[id]?.length}`
				);

				// Prune everything up to well past "now" so this record's only entry is destroyed.
				const cutoff = Date.now() + 2000;
				const pruneRes = await pruneBefore(ctx, cutoff);
				ok(
					pruneRes.status === 200,
					`delete_transaction_logs_before expected 200, got ${pruneRes.status}: ${JSON.stringify(pruneRes.body)}`
				);

				const after = await readHistories(ctx, [id]);
				const actualLen = after[id]?.length ?? 0;
				const expectedLen = engine === 'lmdb' ? 0 : 1;
				const wrongProbe = engine === 'lmdb' ? 1 : 0;

				// Deliberately assert a WRONG expected length (the opposite of what's correct for this
				// engine) and confirm the assertion mechanism actually throws — proves the oracle is not
				// silently vacuous before we trust the real (correct) assertion below.
				let armedFired = false;
				try {
					strictEqual(
						actualLen,
						wrongProbe,
						`INTENTIONALLY WRONG probe: expecting ${wrongProbe} to prove the assertion fires`
					);
				} catch (e) {
					armedFired = e instanceof AssertionError;
				}
				ok(
					armedFired,
					`ARMED-ORACLE CHECK FAILED: expected assert.strictEqual(${actualLen}, ${wrongProbe}) to throw AssertionError, oracle may be blind`
				);
				console.log(
					`[QA-725 armed-oracle threads=${threadCount} engine=${engine}] confirmed assertion fires on a known-wrong claim (actual=${actualLen})`
				);

				// Now the real, engine-correct assertion.
				strictEqual(
					actualLen,
					expectedLen,
					`after pruning past cutoff on ${engine}, ${id} should have ${expectedLen} surviving audit entries, got ${actualLen}`
				);
			});

			// ---- Q1: burst correctness -----------------------------------------------------------
			test('Q1: burst creates+updates+deletes — exactly-one-per-write, ordered, no loss', async () => {
				const COUNT = 40;
				const { ids, deletedIds } = await burst(ctx, `q1-${threadCount}`, COUNT);
				const histories = await readHistories(ctx, ids);

				let totalEntries = 0;
				const violations: string[] = [];
				for (const id of ids) {
					const entries = histories[id] ?? [];
					totalEntries += entries.length;
					const expectedLen = deletedIds.includes(id) ? 4 : 3;
					if (entries.length !== expectedLen) {
						violations.push(
							`${id}: expected ${expectedLen} entries, got ${entries.length} (${JSON.stringify(entries.map(opOf))})`
						);
						continue;
					}
					// Ordering: timestamps must be non-decreasing.
					for (let i = 1; i < entries.length; i++) {
						if (entries[i].timestamp < entries[i - 1].timestamp) {
							violations.push(
								`${id}: out-of-order timestamps at index ${i} (${entries[i - 1].timestamp} -> ${entries[i].timestamp})`
							);
						}
					}
					// Operation sequence: insert, update, update, [delete].
					const ops = entries.map(opOf);
					const expectedOps = deletedIds.includes(id)
						? ['insert', 'update', 'update', 'delete']
						: ['insert', 'update', 'update'];
					if (JSON.stringify(ops) !== JSON.stringify(expectedOps)) {
						violations.push(
							`${id}: operation sequence ${JSON.stringify(ops)} !== expected ${JSON.stringify(expectedOps)}`
						);
					}
				}
				console.log(
					`[QA-725 Q1 threads=${threadCount}] ids=${ids.length} totalAuditEntries=${totalEntries} violations=${violations.length}`
				);
				if (violations.length)
					console.log(`[QA-725 Q1 threads=${threadCount}] VIOLATIONS:\n  ${violations.slice(0, 10).join('\n  ')}`);
				strictEqual(
					violations.length,
					0,
					`${violations.length} audit-log invariant violations (see log): ${violations.slice(0, 5).join(' | ')}`
				);
			});

			// ---- Q2: prune boundary honesty (verified by direct re-read, not the reported count) ---
			test('Q2: prune removes only entries before the cutoff; in-window entries survive intact', async () => {
				const oldIds = Array.from({ length: 10 }, (_, i) => `q2old-${threadCount}-${i}`);
				await insert(
					ctx,
					oldIds.map((id) => ({ id, seq: 0, val: 'old' }))
				);
				await update(
					ctx,
					oldIds.map((id) => ({ id, seq: 1, val: 'old-updated' }))
				);

				// Separate the two batches by more than the retention window so there is no
				// ambiguity about which side of the cutoff each batch lands on.
				await sleep((AUDIT_RETENTION_SECONDS + 2) * 1000);
				const cutoff = Date.now();
				await sleep(50);

				const newIds = Array.from({ length: 10 }, (_, i) => `q2new-${threadCount}-${i}`);
				await insert(
					ctx,
					newIds.map((id) => ({ id, seq: 0, val: 'new' }))
				);
				await update(
					ctx,
					newIds.map((id) => ({ id, seq: 1, val: 'new-updated' }))
				);

				const pruneRes = await pruneBefore(ctx, cutoff);
				ok(
					pruneRes.status === 200,
					`delete_transaction_logs_before expected 200, got ${pruneRes.status}: ${JSON.stringify(pruneRes.body)}`
				);
				console.log(`[QA-725 Q2 threads=${threadCount}] prune report: ${JSON.stringify(pruneRes.body)}`);

				const oldHistories = await readHistories(ctx, oldIds);
				const newHistories = await readHistories(ctx, newIds);

				const oldSurvivorCount = oldIds.reduce((acc, id) => acc + (oldHistories[id]?.length ?? 0), 0);
				const newSurvivorCount = newIds.reduce((acc, id) => acc + (newHistories[id]?.length ?? 0), 0);
				console.log(
					`[QA-725 Q2 threads=${threadCount} engine=${engine}] old (pre-cutoff) survivors=${oldSurvivorCount}/20, new (post-cutoff) survivors=${newSurvivorCount}/20`
				);

				// Ground truth is the direct re-read, independent of whatever the prune op reported as
				// its deleted-file/entry count. Per-engine expectation (see header comment): LMDB
				// deletes matching entries directly, so all 20 pre-cutoff entries are genuinely gone.
				// RocksDB's purgeLogs({before}) can only remove whole log FILES, gated on both file
				// rotation (mtime) and RocksDB's own memtable-flush state -- neither is reachable for
				// this small a write volume in a short test process, so all 20 legitimately survive.
				// Either way, post-cutoff entries must never be touched.
				const expectedOldSurvivors = engine === 'lmdb' ? 0 : 20;
				strictEqual(
					oldSurvivorCount,
					expectedOldSurvivors,
					`on ${engine}, pre-cutoff entries should have ${expectedOldSurvivors} survivors, got ${oldSurvivorCount}`
				);
				for (const id of newIds) {
					const entries = newHistories[id] ?? [];
					strictEqual(entries.length, 2, `post-cutoff ${id} should retain both its entries, got ${entries.length}`);
					for (let i = 1; i < entries.length; i++) {
						ok(entries[i].timestamp >= entries[i - 1].timestamp, `post-cutoff ${id} entries out of order`);
					}
				}
			});

			// ---- Q3: concurrent seam — prune racing fresh writes ----------------------------------
			test('Q3: writes landing concurrently with a prune pass are never destroyed', async () => {
				const concurrentIds = Array.from({ length: 20 }, (_, i) => `q3-${threadCount}-${i}`);
				const cutoff = Date.now(); // prune everything up to right now, fired concurrently with fresh writes below
				const [pruneRes] = await Promise.all([
					pruneBefore(ctx, cutoff),
					burst(ctx, `q3-${threadCount}`, 20).then(() => undefined),
				]);
				ok(
					pruneRes.status === 200,
					`delete_transaction_logs_before expected 200, got ${pruneRes.status}: ${JSON.stringify(pruneRes.body)}`
				);

				const histories = await readHistories(ctx, concurrentIds);
				const violations: string[] = [];
				for (const id of concurrentIds) {
					const entries = histories[id] ?? [];
					// burst() deletes the even-indexed half -> 4 entries, else 3. Reconstruct which
					// half from the id suffix the same way burst() does.
					const idx = Number(id.split('-').pop());
					const expectedLen = idx % 2 === 0 ? 4 : 3;
					if (entries.length !== expectedLen) {
						violations.push(
							`${id}: expected ${expectedLen}, got ${entries.length} (${JSON.stringify(entries.map(opOf))})`
						);
					}
				}
				console.log(
					`[QA-725 Q3 threads=${threadCount}] concurrent prune vs writes: violations=${violations.length}/${concurrentIds.length}`
				);
				if (violations.length)
					console.log(`[QA-725 Q3 threads=${threadCount}] VIOLATIONS:\n  ${violations.join('\n  ')}`);
				strictEqual(
					violations.length,
					0,
					`${violations.length} entries destroyed/lost by a prune pass racing concurrent writes`
				);
			});
		}
	);
}

defineSuite(1);
defineSuite(4);
// Always exercise the real-deletion branch regardless of the process's default storage
// engine: CI's default (RocksDB) legitimately no-ops delete_transaction_logs_before for
// this write volume (see header comment), so without an explicit LMDB instance every CI
// run only ever proves the no-op path and never proves prune actually deletes anything.
defineSuite(1, 'lmdb');
