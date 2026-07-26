/**
 * QA-779 (HIGH) — does Harper's RocksDB audit-log purge actually reclaim disk space in the
 * SAME process, or only after a restart?
 *
 * Background (F-225, reproduced last wave): on `storage.engine: rocksdb`, after
 * `delete_audit_logs_before`, `read_audit_log` keeps returning all purged rows with
 * byte-correct payloads for the life of the process (0% reduction), while the `.txnlog`
 * directory listing collapses from 3 files / 26.06MB to 1 file / 6.5KB and the job reports an
 * accurate `transactions_deleted=14800`. Kill + restart on the same `dataRootDir` and the
 * identical queries return 0 rows. The LMDB control is clean and immediate (already isolated as
 * engine-specific in QA-777; not re-run here).
 *
 * HYPOTHESIS UNDER TEST: `purgeLogs()` unlinks the rotated `.txnlog` file from the directory
 * (which is why the listing shrinks immediately), but Harper's own process still holds an open
 * fd/mmap onto that now-unlinked inode. On Linux, unlink does not free a file's blocks until the
 * last open fd closes — so between purge and restart, the "99.98% disk reduction" measured by
 * walking the directory is an ILLUSION: the bytes are still allocated, just invisible to
 * `readdir`/`stat` because the directory entry is gone. This would directly root-cause
 * harper#846 (an EDQUOT restart loop: purge reports success, free space does not move, only a
 * restart clears it).
 *
 * ORACLE: per-process fd inspection via /proc, not df/statvfs (the task's dataRootDir lives on
 * a multi-TB shared filesystem with other processes writing to it — a df delta at 26MB
 * granularity is pure noise). `/proc/<pid>/fd/*` readlink targets ending in " (deleted)" are
 * unlinked-but-open inodes; `fs.statSync()` through that symlink returns the CURRENT stat of the
 * underlying inode (size, blocks) even though the directory entry is gone. `blocks * 512` is the
 * physical bytes still pinned to disk. This is exact and immune to concurrent-fs noise.
 *
 * ARMED: before trusting any measurement, test 1 proves the walker can see a pinned deleted
 * inode it creates itself (open + write 20MB + unlink-while-open), so a later zero reading is
 * not an artifact of a broken walker.
 *
 * THREE MEASUREMENT POINTS (same discriminator the task specifies):
 *   1. BEFORE purge (baseline — should be ~0 pinned-deleted bytes under dataRootDir)
 *   2. AFTER purge, SAME process (directory listing should already show the collapse)
 *   3. AFTER kill + restart on the identical dataRootDir (fresh process, no inherited fds)
 *
 * If (2) shows megabytes of deleted-but-open `.txnlog` inodes pinned that vanish by (3), the
 * hypothesis HOLDS and #846 has a root cause. If nothing is pinned at (2), the directory
 * collapse is real and the phantom reads (F-225) come from an in-memory cache instead — an
 * equally reportable, different root cause for #846 (or none).
 *
 * OUTCOME (settled by this spec, then root-caused by QA-781): nothing is pinned at (2) — the
 * unlink/mmap hypothesis is REFUTED and the reclamation is real and immediate at the OS level.
 * The post-purge phantom reads are an in-process cache: rocksdb-js's `TransactionLog._logBuffers`
 * (`transaction-log-reader.ts`) holds `WeakRef<LogBuffer>` mmaps per logId with no purge
 * invalidation, so a previously-warmed log segment keeps serving byte-correct rows until GC or
 * restart. This spec is therefore the *reclamation* anchor; the cache behavior is tracked
 * separately (F-225).
 *
 * ALSO SETTLES: last wave's reporting oddity — `delete_audit_logs_before` reports
 * `log_files_deleted=0` despite the directory collapsing by 2 files. Source inspection
 * (dataLayer/delete.ts:113, dataLayer/harperBridge/lmdbBridge/lmdbMethods/DeleteAuditLogsBeforeResults.js)
 * shows this is NOT a rocksdb-path bug: `deleteAuditLogsBefore` (the deprecated op) only forwards
 * `entries_deleted` (renamed `transactions_deleted`) into `DeleteAuditLogsBeforeResults` — the
 * `log_files_deleted` field computed internally by `ResourceBridge.deleteTransactionLogsBefore`
 * is discarded before the deprecated op's response is built. The successor op
 * `delete_transaction_logs_before` / `DeleteTransactionLogsBeforeResults` DOES carry
 * `log_files_deleted` through. This test calls both ops and confirms the split directly.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/audit-purge-disk-reclaim.test.ts"
 * Originating QA scenario: QA-779 (promote candidate P-547). Verified on harper main
 * d112560b6244cf5c914d047a8178942f841d5c6e
 * rocksdb-js: 2.5.0
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import {
	readdirSync,
	statSync,
	readFileSync,
	readlinkSync,
	existsSync,
	openSync,
	writeSync,
	closeSync,
	unlinkSync,
	fsyncSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-purge-disk-reclaim');
const SCHEMA = 'data';
const TABLE = 'Ledger';
const skipSuite = process.platform !== 'linux' || process.env.HARPER_RUNTIME === 'bun';

// Same magnitude as the established F-225 finding: 14800 records @ 1800B ~= 26.6MB, comfortably
// past rocksdb-js's 16MB default rotation threshold.
const VOLUME_RECORDS = 14800;
const BATCH_SIZE = 500;
const PAYLOAD_PREFIX_PAD = 'x'.repeat(1780);
function payloadFor(i: number): string {
	return `seq${i}:${PAYLOAD_PREFIX_PAD}`;
}
const SAMPLE_INDICES = [0, 1, 50, 2000, 7400, 12000, 14799];

// ---------------------------------------------------------------------------------------------
// /proc-based fd oracle
// ---------------------------------------------------------------------------------------------

type PinnedFd = { pid: number; fd: string; target: string; size: number; blocksBytes: number; fdinfo: string };

function ppidOf(pid: number): number | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
		// Format: "pid (comm) state ppid ...". comm can contain spaces/parens, so split after the
		// LAST ')' rather than assuming field position.
		const idx = raw.lastIndexOf(')');
		const rest = raw
			.slice(idx + 2)
			.trim()
			.split(/\s+/);
		return Number(rest[1]); // rest[0]=state, rest[1]=ppid
	} catch {
		return undefined;
	}
}

function allPids(): number[] {
	try {
		return readdirSync('/proc')
			.filter((n) => /^\d+$/.test(n))
			.map(Number);
	} catch {
		return [];
	}
}

/** Root pid plus every live descendant (children, grandchildren, ...), found by scanning
 * /proc/<pid>/stat's ppid field for every pid on the box. Defensive against Harper spawning
 * child processes beyond the direct CLI child (worker THREADS share the parent's fd table and
 * don't need separate enumeration, but this covers any child PROCESSES too). */
function descendantPids(rootPid: number): number[] {
	const pids = allPids();
	const parentOf = new Map<number, number>();
	for (const p of pids) {
		const pp = ppidOf(p);
		if (pp !== undefined) parentOf.set(p, pp);
	}
	const result = new Set<number>([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [p, pp] of parentOf) {
			if (result.has(pp) && !result.has(p)) {
				result.add(p);
				changed = true;
			}
		}
	}
	return [...result].filter((p) => existsSync(`/proc/${p}`));
}

/** Walk /proc/<pid>/fd/*, returning every entry whose readlink target is an unlinked-but-open
 * inode (ends in " (deleted)"), with the CURRENT size/blocks of that inode (fs.statSync through
 * the /proc fd symlink resolves to the live inode even though its directory entry is gone) and
 * the raw /proc/<pid>/fdinfo/<fd> contents for cross-check. */
function listOpenDeletedFds(pid: number): PinnedFd[] {
	const fdDir = `/proc/${pid}/fd`;
	let entries: string[];
	try {
		entries = readdirSync(fdDir);
	} catch {
		return [];
	}
	const out: PinnedFd[] = [];
	for (const fd of entries) {
		const fdPath = `${fdDir}/${fd}`;
		let target: string;
		try {
			target = readlinkSync(fdPath);
		} catch {
			continue; // fd closed mid-scan, or no permission
		}
		if (!target.endsWith(' (deleted)')) continue;
		let size = 0;
		let blocksBytes = 0;
		try {
			const st = statSync(fdPath); // stats the underlying (unlinked) inode, not the symlink
			size = st.size;
			blocksBytes = st.blocks * 512;
		} catch {
			/* raced with close */
		}
		let fdinfo = '';
		try {
			fdinfo = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').trim().replace(/\n/g, ' | ');
		} catch {
			/* not all fd kinds expose fdinfo cleanly */
		}
		out.push({ pid, fd, target, size, blocksBytes, fdinfo });
	}
	return out;
}

type PinnedReport = {
	pidsScanned: number[];
	all: PinnedFd[];
	underRoot: PinnedFd[];
	txnlogUnderRoot: PinnedFd[];
	totalBytesUnderRoot: number;
	totalTxnlogBytes: number;
};

function measurePinned(rootPid: number, dataRootDir: string): PinnedReport {
	const pidsScanned = descendantPids(rootPid);
	const all: PinnedFd[] = [];
	for (const pid of pidsScanned) all.push(...listOpenDeletedFds(pid));
	const stripDeleted = (t: string) => t.replace(/ \(deleted\)$/, '');
	const underRoot = all.filter((f) => stripDeleted(f.target).startsWith(dataRootDir));
	const txnlogUnderRoot = underRoot.filter((f) => stripDeleted(f.target).includes('.txnlog'));
	return {
		pidsScanned,
		all,
		underRoot,
		txnlogUnderRoot,
		totalBytesUnderRoot: underRoot.reduce((a, f) => a + f.blocksBytes, 0),
		totalTxnlogBytes: txnlogUnderRoot.reduce((a, f) => a + f.blocksBytes, 0),
	};
}

function fmtMiB(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(3)}MiB`;
}

function fmtReport(label: string, r: PinnedReport): string {
	const lines = [
		`${label}: pids=[${r.pidsScanned.join(',')}] deletedFdsUnderRoot=${r.underRoot.length} ` +
			`(.txnlog-shaped=${r.txnlogUnderRoot.length}) pinnedBytesUnderRoot=${r.totalBytesUnderRoot} (${fmtMiB(r.totalBytesUnderRoot)}) ` +
			`pinnedTxnlogBytes=${r.totalTxnlogBytes} (${fmtMiB(r.totalTxnlogBytes)})`,
	];
	for (const f of r.underRoot) {
		lines.push(
			`${label}:   pid=${f.pid} fd=${f.fd} target="${f.target}" size=${f.size} blocksBytes=${f.blocksBytes} fdinfo="${f.fdinfo}"`
		);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Directory-listing oracle (the ILLUSION side of the discriminator)
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// HTTP helpers (mirrors QA-777's shape)
// ---------------------------------------------------------------------------------------------

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
	throw new Error('QA-779: Probe route never became ready within 60s');
}

async function storageEngineGuess(ctx: ContextWithHarper): Promise<string> {
	const res = await fetch(`${ctx.harper.httpURL}/StorageEngineInfo/`, { headers: { Authorization: authHeader(ctx) } });
	const body = await res.json();
	return body.engineGuess;
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
	throw new Error(`QA-779: job ${jobId} did not complete within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function readAggregateCount(ctx: ContextWithHarper): Promise<number> {
	const r = await rawOp(ctx, {
		operation: 'read_audit_log',
		schema: SCHEMA,
		table: TABLE,
		search_type: 'timestamp',
		search_values: [0],
	});
	ok(r.status === 200, `read_audit_log (aggregate) expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
	const entries: any[] = Array.isArray(r.body) ? r.body : [];
	let totalCount = 0;
	for (const entry of entries) totalCount += (entry.ids ?? []).length;
	return totalCount;
}

async function readIsolated(
	ctx: ContextWithHarper,
	id: string
): Promise<{ present: boolean; seq?: number; payload?: string }> {
	const r = await rawOp(ctx, {
		operation: 'read_audit_log',
		schema: SCHEMA,
		table: TABLE,
		search_type: 'hash_value',
		search_values: [id],
	});
	ok(r.status === 200, `read_audit_log (isolated ${id}) expected 200, got ${r.status}`);
	const list: any[] = Array.isArray(r.body?.[id]) ? r.body[id] : [];
	if (list.length === 0) return { present: false };
	const rec = list[list.length - 1]?.records?.[0];
	if (!rec) return { present: false };
	return { present: true, seq: rec.seq, payload: rec.payload };
}

// ---------------------------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------------------------

suite(
	'QA-779 RocksDB audit-log purge: same-process disk reclaim vs restart-only reclaim',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		const findings: string[] = [];
		const armConfig = {
			threads: { count: 1 },
			logging: { auditLog: true, console: true, level: 'error' },
			storage: { engine: 'rocksdb' },
		};

		let cutoffTimestamp: number;
		let dataRootDir: string;
		let baselineCount: number;
		let point1: PinnedReport;
		let point2: PinnedReport;
		let point3: PinnedReport;
		let preDiskStats: { fileCount: number; totalBytes: number };
		let postDiskStats: { fileCount: number; totalBytes: number };

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: armConfig, env: {} });
			dataRootDir = ctx.harper.dataRootDir;
			// Poll the probe route directly for non-404; do NOT restartHttpWorkers() against a
			// pre-installed fixture (races and flakes on CI, per QA-179's eviction suite note).
			await pollReadiness(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
			// eslint-disable-next-line no-console
			console.log(`\n=== QA-779 findings ===\n${findings.map((f) => '  ' + f).join('\n')}\n`);
		});

		test('0. precondition: engine in effect is rocksdb (hard assert, not assumed)', async () => {
			const guess = await storageEngineGuess(ctx);
			findings.push(`0. StorageEngineInfo.engineGuess=${guess} (expected rocksdb)`);
			ok(guess === 'rocksdb', `PRECONDITION: expected engine rocksdb, got ${guess}`);
		});

		test('1. ARM THE ORACLE: prove the fd walker can see a pinned deleted inode it creates itself', () => {
			const scratchDir = tmpdir();
			const p = join(scratchDir, `qa779-arm-oracle-${process.pid}-${Date.now()}.tmp`);
			const fd = openSync(p, 'w+');
			try {
				const chunk = Buffer.alloc(1024 * 1024, 0xab); // 1MiB chunks x 20 = 20MiB
				for (let i = 0; i < 20; i++) writeSync(fd, chunk);
				fsyncSync(fd);
				unlinkSync(p); // unlink WHILE the fd is still open
				ok(!existsSync(p), 'ARMING SETUP: file should no longer appear in directory listing after unlink');

				const found = listOpenDeletedFds(process.pid);
				const match = found.find((f) => f.target.startsWith(p));
				findings.push(
					`1. ARMING: walker(self pid=${process.pid}) found ${found.length} deleted-fd entries total; ` +
						`match for our 20MiB unlinked file: ${match ? `size=${match.size} blocksBytes=${match.blocksBytes} (${fmtMiB(match.blocksBytes)}) fdinfo="${match.fdinfo}"` : 'NOT FOUND'}`
				);
				ok(
					match,
					`ARMING FAILED: walker did not detect our own deliberately-created deleted-but-open fd for ${p} — an unarmed oracle, any later zero is worthless`
				);
				ok(
					match.blocksBytes >= 19 * 1024 * 1024,
					`ARMING FAILED: walker reported only ${match.blocksBytes} bytes pinned for a 20MiB unlinked file (expected >= ~19MiB accounting for fs block rounding)`
				);
				findings.push(
					'1. ARMING PASSED: walker correctly reports pinned bytes for a self-created unlinked-but-open inode.'
				);
			} finally {
				closeSync(fd); // release — after this, the OS truly frees the blocks
			}
		});

		test('2. settle the reporting-oddity question: does delete_audit_logs_before ever carry log_files_deleted?', async () => {
			// Both ops are async jobs — the immediate HTTP response is just {message, job_id} for
			// either one, so the comparison has to be made on the POLLED job's `result`, not the ack.
			// timestamp:0 => nothing purged either way (deleted.length===0 internally), which is
			// exactly what isolates "is the key present-but-zero" from "is the key absent entirely".
			const deprecatedAck = await rawOp(ctx, {
				operation: 'delete_audit_logs_before',
				schema: SCHEMA,
				table: TABLE,
				timestamp: 0,
			});
			ok(
				deprecatedAck.status === 200 && deprecatedAck.body?.job_id,
				`deprecated op should return a job_id, got ${deprecatedAck.text.slice(0, 300)}`
			);
			const deprecatedJob = await pollJob(ctx, deprecatedAck.body.job_id);

			const currentAck = await rawOp(ctx, {
				operation: 'delete_transaction_logs_before',
				schema: SCHEMA,
				table: TABLE,
				timestamp: 0,
			});
			ok(
				currentAck.status === 200 && currentAck.body?.job_id,
				`current op should return a job_id, got ${currentAck.text.slice(0, 300)}`
			);
			const currentJob = await pollJob(ctx, currentAck.body.job_id);

			findings.push(
				`2. delete_audit_logs_before (deprecated) polled job.result: ${JSON.stringify(deprecatedJob.result)}`
			);
			findings.push(
				`2. delete_transaction_logs_before (current) polled job.result: ${JSON.stringify(currentJob.result)}`
			);
			const deprecatedHas = Object.prototype.hasOwnProperty.call(deprecatedJob.result ?? {}, 'log_files_deleted');
			const currentHas = Object.prototype.hasOwnProperty.call(currentJob.result ?? {}, 'log_files_deleted');
			findings.push(
				`2. VERDICT: 'log_files_deleted' present on deprecated op's job.result = ${deprecatedHas}; present on current op's job.result = ${currentHas}. ` +
					`Source (dataLayer/delete.ts:108-113) confirms the deprecated deleteAuditLogsBefore path builds a DeleteAuditLogsBeforeResults that only forwards ` +
					`start_timestamp/end_timestamp/entries_deleted(as transactions_deleted) — log_files_deleted is computed internally by ` +
					`ResourceBridge.deleteTransactionLogsBefore but is DISCARDED before the deprecated op responds, regardless of engine. It is not a rocksdb-specific bug; ` +
					`it is the deprecated op's response shape never having carried the field.`
			);
			ok(
				!deprecatedHas,
				`deprecated op's job.result unexpectedly includes log_files_deleted: ${JSON.stringify(deprecatedJob.result)}`
			);
			ok(
				currentHas,
				`current (successor) op's job.result is missing log_files_deleted, contradicting source-read expectation: ${JSON.stringify(currentJob.result)}`
			);
		});

		test('3. seed volume past rotation threshold, capture cutoff', { timeout: 300_000 }, async () => {
			for (let start = 0; start < VOLUME_RECORDS; start += BATCH_SIZE) {
				const records = [];
				for (let i = start; i < Math.min(start + BATCH_SIZE, VOLUME_RECORDS); i++) {
					records.push({ id: `k${i}`, seq: i, payload: payloadFor(i) });
				}
				const r = await rawOp(ctx, { operation: 'insert', schema: SCHEMA, table: TABLE, records });
				ok(r.status === 200, `insert batch@${start} should succeed, got ${r.status}: ${r.text.slice(0, 300)}`);
			}
			await sleep(250);
			cutoffTimestamp = Date.now();
			baselineCount = await readAggregateCount(ctx);
			findings.push(
				`3. seeded ${VOLUME_RECORDS} records; cutoffTimestamp=${cutoffTimestamp}; baseline aggregate row count=${baselineCount}`
			);
			ok(
				baselineCount >= VOLUME_RECORDS,
				`POSITIVE CONTROL FAILED: aggregate count (${baselineCount}) should be >= inserted volume`
			);

			const flushRes = await fetch(`${ctx.harper.httpURL}/Flush/`, {
				method: 'POST',
				headers: { Authorization: authHeader(ctx) },
			});
			ok(flushRes.status === 200, `/Flush/ should succeed, got ${flushRes.status}`);
			preDiskStats = txnLogStats(dataRootDir);
			findings.push(
				`3. PRE-PURGE on-disk .txnlog stats: fileCount=${preDiskStats.fileCount} totalBytes=${preDiskStats.totalBytes} (${fmtMiB(preDiskStats.totalBytes)})`
			);
		});

		test('4. MEASUREMENT POINT 1: pinned deleted-fd bytes BEFORE purge (expected ~0)', () => {
			const rootPid = ctx.harper.process.pid!;
			point1 = measurePinned(rootPid, dataRootDir);
			findings.push(fmtReport('4. POINT1 (pre-purge)', point1));
			ok(true); // observational baseline, not a gate
		});

		test('5. purge: delete_audit_logs_before(cutoff), poll job to completion', { timeout: 120_000 }, async () => {
			const prune = await rawOp(ctx, {
				operation: 'delete_audit_logs_before',
				schema: SCHEMA,
				table: TABLE,
				timestamp: cutoffTimestamp,
			});
			ok(
				prune.status === 200,
				`delete_audit_logs_before should not error, got ${prune.status}: ${prune.text.slice(0, 400)}`
			);
			const jobId = prune.body?.job_id;
			ok(jobId, `delete_audit_logs_before should return a job_id, got: ${JSON.stringify(prune.body)}`);
			const jobResult = await pollJob(ctx, jobId);
			findings.push(
				`5. purge job result: status=${jobResult.status} message=${jobResult.message} result=${JSON.stringify(jobResult.result)}`
			);
			ok(
				jobResult.status === 'COMPLETE',
				`purge job should COMPLETE, got status=${jobResult.status} message=${jobResult.message}`
			);
			(ctx as any).__qa779_jobResult = jobResult;
		});

		test('6. MEASUREMENT POINT 2: directory listing vs pinned deleted-fd bytes, SAME process, immediately AFTER purge', async () => {
			const jobResult = (ctx as any).__qa779_jobResult;
			const reportedDeleted = jobResult?.result?.transactions_deleted ?? 0;
			const reportedFiles = jobResult?.result?.log_files_deleted ?? 0;

			postDiskStats = txnLogStats(dataRootDir);
			const postCount = await readAggregateCount(ctx);

			findings.push(`6. purge reported: transactions_deleted=${reportedDeleted} log_files_deleted=${reportedFiles}`);
			findings.push(
				`6. POST-PURGE on-disk .txnlog stats (directory listing): fileCount=${postDiskStats.fileCount} totalBytes=${postDiskStats.totalBytes} (${fmtMiB(postDiskStats.totalBytes)}) ` +
					`— was fileCount=${preDiskStats.fileCount} totalBytes=${preDiskStats.totalBytes} (${fmtMiB(preDiskStats.totalBytes)})`
			);
			findings.push(
				`6. POST-PURGE (same process) aggregate row count: ${postCount} (baseline was ${baselineCount}) — read_audit_log still serving purged rows?`
			);

			// Cross-check F-225's specific claim directly in THIS run: isolated hash_value read-back,
			// same process, for sample ids spanning the whole insert range, so we can see whether the
			// aggregate count drop (14800 -> postCount) reflects genuinely-gone data or whether some
			// individual ids still resolve to byte-correct payloads despite their file being unlinked.
			const isoResults: string[] = [];
			for (const idx of SAMPLE_INDICES) {
				const id = `k${idx}`;
				const iso = await readIsolated(ctx, id);
				const correct = iso.present && iso.seq === idx && iso.payload === payloadFor(idx);
				isoResults.push(`${id}:${iso.present ? (correct ? 'BYTE-CORRECT' : `WRONG(seq=${iso.seq})`) : 'GONE'}`);
			}
			findings.push(
				`6. POST-PURGE (same process) isolated hash_value read-back for sample ids: ${isoResults.join(', ')}`
			);

			const rootPid = ctx.harper.process.pid!;
			point2 = measurePinned(rootPid, dataRootDir);
			findings.push(fmtReport('6. POINT2 (post-purge, same process)', point2));

			findings.push(
				`6. DISCRIMINATOR (pre-restart): directory bytes dropped by ${preDiskStats.totalBytes - postDiskStats.totalBytes} ` +
					`(${(((preDiskStats.totalBytes - postDiskStats.totalBytes) / (preDiskStats.totalBytes || 1)) * 100).toFixed(2)}%) while pinned-deleted-fd ` +
					`bytes under dataRootDir = ${point2.totalBytesUnderRoot} (${fmtMiB(point2.totalBytesUnderRoot)}), of which .txnlog-shaped = ${point2.totalTxnlogBytes} (${fmtMiB(point2.totalTxnlogBytes)})`
			);
			ok(true);
		});

		test(
			'7. restart on the identical dataRootDir (fresh process, no inherited fds)',
			{ timeout: 120_000 },
			async () => {
				await killHarper(ctx as any);
				await startHarper(ctx, { config: armConfig, env: {} });
				await pollReadiness(ctx);
				findings.push(`7. restarted Harper on same dataRootDir; new pid=${ctx.harper.process.pid}`);
			}
		);

		test('8. MEASUREMENT POINT 3: pinned deleted-fd bytes AFTER restart, and does the phantom read vanish?', async () => {
			const rootPid = ctx.harper.process.pid!;
			point3 = measurePinned(rootPid, dataRootDir);
			findings.push(fmtReport('8. POINT3 (post-restart)', point3));

			const postRestartCount = await readAggregateCount(ctx);
			const postRestartDiskStats = txnLogStats(dataRootDir);
			findings.push(
				`8. POST-RESTART aggregate row count: ${postRestartCount} (was ${baselineCount} pre-purge, ${await Promise.resolve('n/a')} same-process post-purge showed ${'(see test 6)'})`
			);
			findings.push(
				`8. POST-RESTART on-disk .txnlog stats: fileCount=${postRestartDiskStats.fileCount} totalBytes=${postRestartDiskStats.totalBytes}`
			);

			let sampleGoneAfterRestart = 0;
			for (const idx of SAMPLE_INDICES) {
				const id = `k${idx}`;
				const iso = await readIsolated(ctx, id);
				if (!iso.present) sampleGoneAfterRestart++;
			}
			findings.push(
				`8. of ${SAMPLE_INDICES.length} sampled purged ids, ${sampleGoneAfterRestart} are now unreadable post-restart (vs 0 same-process post-purge, per F-225)`
			);

			findings.push('8. THREE-POINT SUMMARY:');
			findings.push(
				`8.   POINT1 (pre-purge)          pinnedTxnlogBytes=${point1.totalTxnlogBytes} (${fmtMiB(point1.totalTxnlogBytes)})`
			);
			findings.push(
				`8.   POINT2 (post-purge, same proc) pinnedTxnlogBytes=${point2.totalTxnlogBytes} (${fmtMiB(point2.totalTxnlogBytes)})`
			);
			findings.push(
				`8.   POINT3 (post-restart)       pinnedTxnlogBytes=${point3.totalTxnlogBytes} (${fmtMiB(point3.totalTxnlogBytes)})`
			);

			const holds = point2.totalTxnlogBytes > 1024 * 1024 && point3.totalTxnlogBytes === 0;
			const noPinning = point2.totalTxnlogBytes === 0;
			findings.push(
				`8. VERDICT: ${
					holds
						? `HYPOTHESIS HOLDS — ${fmtMiB(point2.totalTxnlogBytes)} of .txnlog bytes were pinned to a deleted-but-open inode immediately after purge (same process), and dropped to 0 after restart. The directory-listing "reduction" measured at test 6 is an ILLUSION during the life of the process; the blocks are not actually returned to the filesystem until the last fd closes at restart. This directly root-causes harper#846 (EDQUOT restart loop: purge reports success, free space does not move, only a restart clears it).`
						: noPinning
							? `HYPOTHESIS DOES NOT HOLD — no pinned deleted-but-open .txnlog inodes were observed post-purge despite the directory listing collapsing and read_audit_log continuing to serve purged rows (F-225). The space really was freed at the OS level; the phantom reads must be served from an in-memory cache (not a stale mmap/fd), which is a DIFFERENT root cause and would NOT explain harper#846's EDQUOT via this mechanism.`
							: `MIXED/INCONCLUSIVE — some pinning observed post-purge (${fmtMiB(point2.totalTxnlogBytes)}) but it did not clear (or did not exist) as cleanly as the two-sided hypothesis predicts; needs a follow-up run with finer-grained per-file identity tracking.`
				}`
			);
			// The anchored invariant (green on current main): an audit purge must not leave rotated
			// .txnlog blocks pinned to an unlinked-but-open inode. A regression here is exactly the
			// harper#846 shape — purge reports success, the directory listing collapses, and the
			// filesystem never actually gets its blocks back until the process restarts.
			strictEqual(point1.totalTxnlogBytes, 0, 'pre-purge: no deleted-but-open .txnlog inodes expected');
			strictEqual(
				point2.totalTxnlogBytes,
				0,
				`post-purge SAME PROCESS: purge leaked ${fmtMiB(point2.totalTxnlogBytes)} of .txnlog blocks pinned to unlinked-but-open fds — disk is not actually reclaimed until restart (harper#846 shape)`
			);
			strictEqual(point3.totalTxnlogBytes, 0, 'post-restart: no deleted-but-open .txnlog inodes expected');
			// The restart-side half of F-225: whatever the process served pre-restart, a purged row
			// must be gone once the stale in-memory state is dropped.
			strictEqual(
				sampleGoneAfterRestart,
				SAMPLE_INDICES.length,
				`post-restart: all ${SAMPLE_INDICES.length} sampled purged ids must be unreadable, ${SAMPLE_INDICES.length - sampleGoneAfterRestart} still readable`
			);
			ok(
				postRestartDiskStats.totalBytes < preDiskStats.totalBytes,
				'post-restart .txnlog bytes must stay below the pre-purge baseline'
			);
		});
	}
);
