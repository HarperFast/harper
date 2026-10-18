/**
 * QA-822 — permanent anchor for what a real transaction-log purge leaves behind on RocksDB.
 *
 * Background. `delete_transaction_logs_before` deletes whole native transaction-log files, and a
 * RocksDB transaction log is per-DATABASE, not per-table. `qa816-purge-blast-radius.test.ts` pins
 * the blast radius of that (a purge destroys audit history and only audit history); this file pins
 * the state the log itself is left in, and the durability of everything written afterwards.
 *
 * The four invariants, each asserted once and each able to fail for exactly one reason:
 *
 *   1. A PURGE NEVER STRANDS THE FLUSH POSITION. After a purge that really deleted files, the
 *      log's `lastFlushedPosition` is still a sound witness — never the `{sequence:0, offset:0}`
 *      sentinel — and it still is once that process has shut down and reopened. Since rocksdb-js#911
 *      (2.12.0) a purge may delete every fully flushed file, the one `txn.state` names and the
 *      writer's current segment included, so an idle flushed log legitimately has NO files left. The
 *      witness then has to carry the contract on its own: with no files, the writer has retired past
 *      the witnessed sequence so the next append lands above it; with files, the position lies inside
 *      the range the purge kept; and a restart never moves the position backwards (`txn.state` only
 *      moves forward, and `load()` starts appends at F+1). This is #911's witness contract stated as
 *      an executable claim; it is the assertion that goes red if a purge ever strands the position or
 *      a restart appends behind it.
 *      What the second sample does NOT isolate: invariant 3 needs rows written by the purging
 *      process before it restarts, and those writes are themselves enough to rewrite flush state,
 *      so a regression visible only on a no-write reopen would be masked there. The first sample —
 *      taken in the purging process with zero writes since the purge — is the one that isolates it,
 *      and it is the sample that fails on a pre-#799 binding. Invariant 4 below supplies the
 *      missing no-write sample.
 *   2. COMMIT GROUPING IS IRRELEVANT. The same 260 records advance the log's write cursor by the
 *      same number of bytes whether they arrive as 260 single-row commits or as one 260-row commit.
 *      The log's byte layout is a function of the records, not of how a client grouped them into
 *      transactions, so no client write pattern can be closer to or further from a flush than
 *      another. Nothing about this is purge-specific; it is measured here because the arming this
 *      file already does gives it a real, non-empty log to measure against. Note what kind of claim
 *      this is: it holds because `RocksTransactionLogStore` frames the log per RECORD (`addEntry`
 *      per audit entry, with the transaction boundary carried as a flag), so it is an empirical
 *      anchor on that layout rather than a published contract. Native per-transaction framing would
 *      be a deliberate change, and this assertion is meant to be the thing that notices it.
 *   3. THERE IS NO PARTIAL-LOSS WINDOW AFTER A PURGE. Markers planted at four points across the
 *      post-purge window all survive a clean shutdown together. The sharpest is the first: rows
 *      written by the very process that ran the purge, before it has restarted, which is the
 *      residual exposure the QA-822 family named. Then a single row first thing in the new process,
 *      then two more across a write ramp. The failure mode this forbids is the expensive one: a
 *      silent prefix of the window being dropped while later rows survive, which no operator could
 *      detect from the outside.
 *   4. A CLEAN, WRITE-FREE REOPEN LEAVES THE FLUSH POSITION UNTOUCHED (QA-1730, promoted separately
 *      from P-584 as its own candidate). Invariant 1's second sample is a reopen AFTER writes, for
 *      the reason given above; this invariant supplies the missing no-write sample from an isolated
 *      second database (`qa1730`.`ReopenTarget`) that never takes a write after its own purge, so its
 *      restart really is clean — the position must come back byte-identical, not merely non-sentinel.
 *      It also checks what no self-report can, between the kill and the reopen, WHILE THE PROCESS IS
 *      DOWN: that `txn.state` physically holds those eight bytes (the only durable record once the
 *      file it names is gone), and that the purge really deleted every file lying entirely at or
 *      before the position while keeping every file with bytes above it — the #911 rule, which the
 *      #799 floor broke by keeping the fully flushed file the position names.
 *
 * WHY INVARIANT 1 IS STATED AS "NEVER WEDGES" RATHER THAN "HEALS". The QA-822 exploration measured
 * the opposite world. On `@harperfast/rocksdb-js` 2.8.0 this same purge left `lastFlushedPosition`
 * at the `{0,0}` sentinel, a restart with zero writes did not clear it, and it took one row plus a
 * restart to move it off — because `doPurge()` emptied the store's sequence files and then
 * `remove_all`d the directory holding `txn.state` out from under its own open handle
 * (rocksdb-js#808). rocksdb-js#799 shipped a retention floor in v2.9.0 that kept the segment the
 * flush position names; rocksdb-js#911 (v2.12.0) retired that floor, because an idle store could
 * never release its last file, and made `txn.state` the sole durable witness instead (synced with
 * its directory before a store's last file is unlinked, never moved backwards, honoured by `load()`).
 * Measured on this file: 2.11.0 keeps the flushed-position file (`files=1`) and 2.12.0 deletes it
 * (`files=0`, writer at F+1), with the same position bytes and every post-purge marker surviving
 * either way. So the healing behaviour is unreachable on any supported pin, and asserting it would
 * land a permanently red test. Invariant 1 pins the witness instead, which is the stronger claim;
 * the durability half of the original — "and that row survives" — is preserved among invariant 3's
 * checkpoints.
 *
 * Deliberately NOT asserted, because asserting it would make this file drift or go red for reasons
 * that are not regressions:
 *   - Any flush byte boundary. A size-triggered flush is RocksDB's write-buffer tunable, not a
 *     Harper contract, and the exploration bounded it rather than bisecting it.
 *   - Any agreement between the two `read_audit_log` surfaces. The timestamp-ranged (aggregate)
 *     read has been measured returning zero post-restart over rows the per-id `hash_value` read
 *     returns in full. That divergence is a separately-tracked read-path question, so every
 *     survival oracle here is the per-id surface at full N — never the aggregate, never a sample.
 *
 * Arming. Every assertion below is vacuous if the purge did nothing, so the purge must report both
 * deleted entries and deleted FILES (the file deletion is the part that could strand the flush
 * position), each checkpoint must read back correct in-process before the shutdown that is supposed
 * to preserve it, and neither commit shape may rotate the log — an offset delta across a rotation
 * would measure the rotation instead of the records.
 *
 * Proof boundary. Clean shutdowns only — every restart asserts exitCode:0/signalCode:null, so an
 * escalation to SIGKILL fails loudly here instead of silently invalidating what the restart was
 * supposed to prove; an unclean `kill -9` inside the post-purge window is not covered. RocksDB only, pinned by this suite's own config and env rather than inherited from the
 * run, so an `HARPER_STORAGE_ENGINE=lmdb` pass of the suite exercises the same RocksDB behaviour
 * instead of going vacuous. LMDB is excluded by construction, not by omission: it keeps a
 * transaction log per table with no native `txn.state`, so it has no flush position to strand.
 *
 * Reproduction:
 *   cd <harper checkout> && npm run build && npm run test:integration -- \
 *     "integrationTests/database/qa822-purge-log-invariants.test.ts"
 *
 * Promoted from QA-822 (qa-explorer), snapshot P-584, trimmed to the invariants: the snapshot's
 * threshold/event/exposure sweeps measured the healing boundary and asserted nothing. Invariant 4
 * is promoted separately from QA-1730, the same P-584 lineage, after hardening its oracle: the
 * banked snapshot's `assertReopen` never checked that the shutdown-time file inventory contained
 * the retained floor file (only that removed files were absent), and its post-`killHarper` check
 * only ruled out SIGKILL rather than requiring the documented graceful exit.
 * Related: `qa816-purge-blast-radius.test.ts`, rocksdb-js#911 (the witness contract invariants 1 and
 * 4 pin), rocksdb-js#799 (the retention floor it replaced), rocksdb-js#808 (the wedge), harper#846.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual, throws } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa822-purge-log-invariants');
// Windows is skipped on harper#2401 — `delete_transaction_logs_before` takes the process down
// there, the same reason `qa816-purge-blast-radius.test.ts` skips it. uWS HTTP is skipped on
// harper#3176 — shutdown itself aborts (SIGABRT) there, a worker-thread uv_loop_close assertion
// with open uWS poll handles, caught here because this file is the first to check a killed
// process's exit status. Remove either skip when its issue closes, and do NOT instead make the
// suite tolerate the restart: tolerating it would hide the defect behind a suite whose whole
// subject is what a purge leaves behind.
// `server/http.ts`'s uWS activation guard is a plain JS truthiness check on the env var
// (`process.env.HARPER_UWS_HTTP && ...`), not a `=== '1'` comparison — match it exactly, or a
// truthy-but-not-'1' value (`true`, even `'0'`) would run this suite on uWS anyway.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32' || !!process.env.HARPER_UWS_HTTP;

const ARM_CONFIG = {
	threads: { count: 1 },
	logging: { auditLog: true, console: true, level: 'error' },
	storage: { engine: 'rocksdb' },
};
const ARM_ENV = { HARPER_STORAGE_ENGINE: 'rocksdb' };

// The seed has to cross the log's rotation size, because a purge against a single still-active
// segment deletes nothing and would arm every assertion below vacuously. Sized from the log's own
// `maxFileSize` rather than the 16MiB default, so a change to that default cannot silently turn the
// arming into a permanent failure.
const VICTIM_PAD = 'x'.repeat(4200);
const VICTIM_BATCH = 500;
const VICTIM_OVERSHOOT = 1.3;
const DEFAULT_MAX_FILE_SIZE = 16 * 1024 * 1024;

// Invariant 2's two commit shapes. 260 rows × ~4KB ≈ 1.05MiB per shape is deliberately far below
// the 16MiB rotation size, so both shapes land in one log file and their offsets are comparable.
const SHAPE_ROWS = 260;
const SHAPE_PAD = 'x'.repeat(4000);

const MARKER_ROWS = 20;
const MARKER_PAD = 'x'.repeat(300);

// QA-1730's clean-reopen sample lives in its own database so the no-write window its invariant
// needs is structural, not a timing coincidence with the arms above that keep writing to `data`.
const CLEAN_REOPEN_DB = 'qa1730';
const CLEAN_REOPEN_TABLE = 'ReopenTarget';

interface LogPosition {
	sequence: number;
	offset: number;
}

interface LogSnapshot {
	available: boolean;
	engine: string;
	path: string;
	fileCount: number;
	currentSequenceNumber: number;
	oldestSequenceNumber: number;
	nextLogPosition: LogPosition;
	lastFlushedPosition: LogPosition;
	rotations: number;
	entriesWritten: number;
	maxFileSize: number;
}

interface Row {
	id: string;
	seq: number;
	marker: string;
}

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function rawOp(
	ctx: ContextWithHarper,
	operation: any,
	timeoutMs = 120_000
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

async function logStats(ctx: ContextWithHarper, table: string, database = 'data'): Promise<LogSnapshot> {
	const res = await fetch(`${ctx.harper.httpURL}/LogStats/?database=${database}&table=${table}`, {
		headers: { Authorization: authHeader(ctx) },
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	strictEqual(
		res.status,
		200,
		`/LogStats/?database=${database}&table=${table} expected 200, got ${res.status}: ${text.slice(0, 300)}`
	);
	const stats = JSON.parse(text) as LogSnapshot;
	ok(stats.available, `QA-822: no native transaction log for ${database}.${table} (engine=${stats.engine})`);
	return stats;
}

async function flushPrimaryStores(ctx: ContextWithHarper): Promise<void> {
	const res = await fetch(`${ctx.harper.httpURL}/Flush/`, {
		method: 'POST',
		headers: { Authorization: authHeader(ctx) },
		signal: AbortSignal.timeout(120_000),
	});
	const text = await res.text();
	strictEqual(res.status, 200, `/Flush/ expected 200, got ${res.status}: ${text.slice(0, 300)}`);
	const body = JSON.parse(text) as { flushed: Record<string, boolean> };
	for (const [key, flushed] of Object.entries(body.flushed)) {
		ok(flushed, `ORACLE ARMING: /Flush/ reported ${key} did not flush (no RocksDB primaryStore?)`);
	}
}

/**
 * Flush until the log's oldest file is both sealed and fully applied to RocksDB — the two
 * conditions that make it eligible for the native purge. The last-flushed position cannot pass an
 * unflushed column family, and RocksDB's own size-triggered flushes race one explicit flush, so
 * this polls rather than asserts after a single call — the same reason
 * `qa816-purge-blast-radius.test.ts`'s `flushUntilPurgeable` does.
 */
async function flushUntilPurgeable(ctx: ContextWithHarper, table: string, database = 'data'): Promise<LogSnapshot> {
	const deadline = Date.now() + 60_000;
	let stats: LogSnapshot;
	do {
		await flushPrimaryStores(ctx);
		stats = await logStats(ctx, table, database);
		if (
			stats.oldestSequenceNumber < stats.currentSequenceNumber &&
			stats.lastFlushedPosition.sequence > stats.oldestSequenceNumber
		)
			return stats;
		await sleep(250);
	} while (Date.now() < deadline);
	throw new Error(
		`ORACLE ARMING: ${database}.${table}'s oldest transaction-log file never became sealed and fully flushed ` +
			`within 60s (oldest=${stats.oldestSequenceNumber} current=${stats.currentSequenceNumber} lastFlushed=${stats.lastFlushedPosition.sequence})`
	);
}

// `/LogStats/` resolves a fixture table out of `tables`/`databases`, so a 200 for a given
// database.table proves that one is open. A 404 is the component still loading, and a 500 from a
// half-started server would read as ready and resurface later as an opaque failure. Both databases
// are checked, not just `data`, so a `qa1730` access later never races its own database's load.
async function pollReadiness(ctx: ContextWithHarper): Promise<void> {
	for (const [table, database] of [
		['QuietTarget', 'data'],
		[CLEAN_REOPEN_TABLE, CLEAN_REOPEN_DB],
	] as const) {
		const deadline = Date.now() + 90_000;
		let last = 'no response';
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${ctx.harper.httpURL}/LogStats/?database=${database}&table=${table}`, {
					headers: { Authorization: authHeader(ctx) },
					signal: AbortSignal.timeout(5_000),
				});
				if (res.status === 200) {
					last = '';
					break;
				}
				last = `HTTP ${res.status}`;
			} catch (error) {
				last = String((error as Error)?.message ?? error);
			}
			await sleep(250);
		}
		if (last)
			throw new Error(
				`QA-822: /LogStats/?database=${database}&table=${table} never answered 200 within 90s; last=${last}`
			);
	}
}

// A job record can be briefly unreadable right after the ack, so a non-200 or malformed tick is a
// reason to poll again rather than to fail; only the deadline is fatal, and it reports the last tick.
async function pollJob(ctx: ContextWithHarper, jobId: string, timeoutMs = 180_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last = 'no response';
	while (Date.now() < deadline) {
		try {
			const r = await rawOp(ctx, { operation: 'get_job', id: jobId });
			const record = Array.isArray(r.body) ? r.body[0] : r.body;
			if (r.status === 200 && record && typeof record === 'object') {
				if (record.status === 'COMPLETE' || record.status === 'ERROR') return record;
				last = `status=${record.status}`;
			} else {
				last = `HTTP ${r.status}: ${r.text.slice(0, 300)}`;
			}
		} catch (error) {
			last = String((error as Error)?.message ?? error);
		}
		await sleep(500);
	}
	throw new Error(`QA-822: job ${jobId} did not settle within ${timeoutMs}ms; last=${last}`);
}

async function insertRows(ctx: ContextWithHarper, table: string, records: Row[], database = 'data'): Promise<void> {
	const r = await rawOp(ctx, { operation: 'insert', database, table, records });
	strictEqual(r.status, 200, `insert ${records.length} row(s) into ${table} expected 200: ${r.text.slice(0, 300)}`);
}

function markerRows(prefix: string, count: number): Row[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${prefix}_${String(i).padStart(3, '0')}`,
		seq: i,
		marker: `QA822-${prefix}-${i}:${MARKER_PAD}`,
	}));
}

// Both commit shapes write this exact record stream, so the ONLY difference between them is how
// many transactions carry it: equal-width zero-padded ids, identical `seq` values, and one shared
// padding string. Anything that varied per shape would make invariant 2's byte-delta comparison
// measure the payload instead of the grouping.
function shapeRows(prefix: string): Row[] {
	return Array.from({ length: SHAPE_ROWS }, (_, i) => ({
		id: `${prefix}_${String(i).padStart(3, '0')}`,
		seq: i,
		marker: SHAPE_PAD,
	}));
}

function isSentinel(position: LogPosition): boolean {
	return position?.sequence === 0 && position?.offset === 0;
}

function comparePositions(left: LogPosition, right: LogPosition): number {
	return left.sequence - right.sequence || left.offset - right.offset;
}

/**
 * The flush position as a sound witness (rocksdb-js#911): never the sentinel; with no log files left,
 * the writer has retired past the witnessed sequence (or sits on it when nothing was ever written to
 * it); with files, the position lies inside the range the purge kept.
 */
function assertWitness(stats: LogSnapshot, preamble: string): void {
	const position = stats.lastFlushedPosition;
	ok(
		!isSentinel(position),
		`${preamble} The position is the {0,0} sentinel, which is what a stranded position reads as. Got ${fmt(stats)}`
	);
	if (stats.fileCount === 0) {
		ok(
			stats.currentSequenceNumber > position.sequence ||
				(position.offset === 0 && stats.currentSequenceNumber === position.sequence),
			`${preamble} With no log files left the writer must have retired past the witnessed sequence, so the next append lands above it. Got ${fmt(stats)}`
		);
	} else {
		ok(
			position.sequence >= stats.oldestSequenceNumber && position.sequence <= stats.currentSequenceNumber,
			`${preamble} The position names a sequence outside the range of files the purge kept. Got ${fmt(stats)}`
		);
	}
}

function fmt(stats: LogSnapshot): string {
	const position = stats.lastFlushedPosition;
	return (
		`lastFlushed={seq:${position?.sequence},off:${position?.offset}}${isSentinel(position) ? ' <-- SENTINEL' : ''} ` +
		`oldestSeq=${stats.oldestSequenceNumber} currentSeq=${stats.currentSequenceNumber} files=${stats.fileCount}`
	);
}

/**
 * The per-id `hash_value` audit surface at full N, read in one call. This is the suite's only
 * survival oracle: the timestamp-ranged surface has been measured reading 0 post-restart over rows
 * this one returns intact, so the aggregate is not a valid statement about what is on disk here.
 */
async function auditRecordsById(ctx: ContextWithHarper, table: string, ids: string[]): Promise<Map<string, any>> {
	const r = await rawOp(ctx, {
		operation: 'read_audit_log',
		database: 'data',
		table,
		search_type: 'hash_value',
		search_values: ids,
	});
	strictEqual(r.status, 200, `read_audit_log(${table}) expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
	const found = new Map<string, any>();
	for (const id of ids) {
		const entries = Array.isArray(r.body?.[id]) ? r.body[id] : [];
		const record = entries[entries.length - 1]?.records?.[0];
		if (record) found.set(id, record);
	}
	return found;
}

async function assertMarkersIntact(ctx: ContextWithHarper, label: string, rows: Row[]): Promise<void> {
	const found = await auditRecordsById(
		ctx,
		'QuietTarget',
		rows.map((row) => row.id)
	);
	const missing = rows.filter((row) => !found.has(row.id)).map((row) => row.id);
	strictEqual(
		missing.length,
		0,
		`[${label}] only ${rows.length - missing.length}/${rows.length} planted audit rows are readable; missing ${missing.join(',')}`
	);
	for (const row of rows) {
		deepStrictEqual(
			{ seq: found.get(row.id).seq, marker: found.get(row.id).marker },
			{ seq: row.seq, marker: row.marker },
			`[${label}] ${row.id} is present but came back modified`
		);
	}
}

// Rotation is observed asynchronously, so exhausting the seed budget is not yet proof it happened.
// Without it the purge has no sealed file to delete and the arming below fails for a reason that
// has nothing to do with what this suite asserts.
async function waitForRotation(
	ctx: ContextWithHarper,
	before: number,
	table = 'PurgeVictim',
	database = 'data'
): Promise<number> {
	const deadline = Date.now() + 60_000;
	let rotations = before;
	while (Date.now() < deadline) {
		rotations = (await logStats(ctx, table, database)).rotations;
		if (rotations > before) return rotations;
		await sleep(250);
	}
	throw new Error(`ORACLE ARMING: the seed never rotated the transaction log (rotations still ${rotations})`);
}

// QA-1730's second oracle gap: a reopened process's self-report cannot distinguish a floor file
// that was truly persisted from one a clean recomputation on open happened to reproduce. Reading
// the log directory directly WHILE THE PROCESS IS DOWN (between the kill and the next start) can.
function diskLogFiles(logDirPath: string): { seq: number; bytes: number }[] {
	return readdirSync(logDirPath)
		.filter((name) => /^\d+\.txnlog$/.test(name))
		.map((name) => ({ seq: Number(name.slice(0, -'.txnlog'.length)), bytes: statSync(join(logDirPath, name)).size }));
}

// `txn.state` is eight little-endian bytes: uint32 offset, then uint32 sequence (rocksdb-js's
// `LogPosition`), rewritten in place. Once the file it names is purged it is the only durable witness.
function diskFlushedPosition(logDirPath: string): LogPosition {
	const bytes = readFileSync(join(logDirPath, 'txn.state'));
	strictEqual(bytes.length, 8, `txn.state must hold exactly one 8-byte position, got ${bytes.length} bytes`);
	return { offset: bytes.readUInt32LE(0), sequence: bytes.readUInt32LE(4) };
}

function assertPurgeRuleOnDisk(
	files: { seq: number; bytes: number }[],
	logDirPath: string,
	witness: LogPosition,
	label: string
): void {
	deepStrictEqual(
		diskFlushedPosition(logDirPath),
		witness,
		`${label}: txn.state on disk must hold the exact position the process reported before it went down`
	);
	// rocksdb-js#911: a file lying entirely at or before the flushed position is purgeable, the file the
	// position names and the current segment included; a file with bytes above the position is not.
	const leftBehind = files.filter(
		(file) => file.seq < witness.sequence || (file.seq === witness.sequence && file.bytes <= witness.offset)
	);
	deepStrictEqual(
		leftBehind,
		[],
		`${label}: every log file lying entirely at or before the flushed position (seq:${witness.sequence}, ` +
			`offset:${witness.offset}) must have been purged; got files=${JSON.stringify(files)}`
	);
}

interface ExitStatus {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
}

// Harper's SIGTERM/SIGINT/SIGQUIT handler (bin/run.ts addExitListeners) calls process.exit(0)
// after beginProcessShutdown(), so a graceful shutdown reads exitCode:0, signalCode:null — not
// merely "didn't get SIGKILLed". A process that was killed BY an uncaught signal instead reads
// exitCode:null, signalCode:'SIGTERM', and never ran that clean-shutdown path.
function assertGracefulExit(status: ExitStatus, label: string): void {
	ok(
		status.exitCode === 0 && status.signalCode === null,
		`${label}: expected a graceful exit (exitCode:0, signalCode:null), got exitCode:${status.exitCode} signalCode:${status.signalCode}`
	);
}

// Every restart in this file backs a "clean shutdown" claim (the header's proof boundary, or
// invariant 4's own), so every restart checks it here once rather than at each call site.
// `onShutdown` runs after the process has exited and before the next one starts, so it can inspect
// disk state without a live process racing it — before the graceful-exit check itself, so a bad
// onShutdown still surfaces as its own error rather than masking an ungraceful exit underneath it.
async function restart(ctx: ContextWithHarper, label: string, onShutdown?: () => Promise<void> | void): Promise<void> {
	const dyingProcess = ctx.harper.process;
	await killHarper(ctx as any, { graceMs: 30_000 });
	if (onShutdown) await onShutdown();
	assertGracefulExit(
		{ exitCode: dyingProcess.exitCode, signalCode: dyingProcess.signalCode },
		`${label}: shutdown before restart`
	);
	await startHarper(ctx, { config: ARM_CONFIG, env: ARM_ENV });
	await pollReadiness(ctx);
}

suite(
	'QA-822 transaction-log purge invariants: retained flush position, grouping-independent layout, no partial loss [rocksdb]',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		const findings: string[] = [];
		const sameProcess = { label: 'same-process (written by the purging process)', rows: markerRows('sp', MARKER_ROWS) };
		const cp0 = { label: 'cp0 (one row, before any further volume)', rows: markerRows('cp0', 1) };
		const cp1 = { label: 'cp1 (after 260 single-row commits)', rows: markerRows('cp1', MARKER_ROWS) };
		const cp2 = { label: 'cp2 (after one 260-row commit)', rows: markerRows('cp2', MARKER_ROWS) };
		const checkpoints = [sameProcess, cp0, cp1, cp2];
		let postPurge: LogSnapshot;
		let postPurgeRestart: LogSnapshot;
		let manyCommitBytes = Number.NaN;
		let oneCommitBytes = Number.NaN;
		let purged = false;
		let ramped = false;
		let cleanReopenBoundary: LogSnapshot;
		let cleanReopenDiskFiles: { seq: number; bytes: number }[];
		let cleanReopenReopened: LogSnapshot;
		let cleanReopened = false;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: ARM_CONFIG, env: ARM_ENV });
			await pollReadiness(ctx);
		});

		after(async () => {
			try {
				await teardownHarper(ctx);
			} finally {
				// eslint-disable-next-line no-console
				console.log(`\n=== QA-822 findings ===\n${findings.map((line) => '  ' + line).join('\n')}\n`);
			}
		});

		test('0. precondition: the fixture is on RocksDB with a native transaction log', async () => {
			const stats = await logStats(ctx, 'QuietTarget');
			strictEqual(stats.engine, 'rocksdb', `PRECONDITION: this suite is RocksDB-only, got engine=${stats.engine}`);
			findings.push(`0. maxFileSize=${stats.maxFileSize} at start: ${fmt(stats)}`);
		});

		test(
			'1. arm: seed past a rotation and run a purge that really deletes log files',
			{ timeout: 600_000 },
			async () => {
				const seedStart = await logStats(ctx, 'PurgeVictim');
				const maxFileSize = seedStart.maxFileSize > 0 ? seedStart.maxFileSize : DEFAULT_MAX_FILE_SIZE;
				const victimRows = Math.ceil((maxFileSize * VICTIM_OVERSHOOT) / VICTIM_PAD.length);
				for (let start = 0; start < victimRows; start += VICTIM_BATCH) {
					const records = Array.from({ length: Math.min(VICTIM_BATCH, victimRows - start) }, (_, i) => ({
						id: `pv_${start + i}`,
						seq: start + i,
						marker: VICTIM_PAD,
					}));
					await insertRows(ctx, 'PurgeVictim', records);
				}

				const rotations = await waitForRotation(ctx, seedStart.rotations);
				findings.push(
					`1. seeded ${victimRows} rows x ${VICTIM_PAD.length}B against maxFileSize=${maxFileSize}; rotations ${seedStart.rotations} -> ${rotations}`
				);

				await flushUntilPurgeable(ctx, 'PurgeVictim');
				const cutoffTimestamp = Date.now();

				// Database-scoped on purpose: a RocksDB transaction log is per-database, so a `table`-scoped
				// request is refused outright (`ResourceBridge.deleteTransactionLogsBefore`, harper#2049).
				const ack = await rawOp(ctx, {
					operation: 'delete_transaction_logs_before',
					database: 'data',
					timestamp: cutoffTimestamp,
				});
				strictEqual(
					ack.status,
					200,
					`delete_transaction_logs_before expected 200, got ${ack.status}: ${ack.text.slice(0, 300)}`
				);
				ok(ack.body?.job_id, `delete_transaction_logs_before must return a job_id, got ${ack.text.slice(0, 300)}`);

				const job = await pollJob(ctx, ack.body.job_id);
				findings.push(`1. purge job ${job.status} result=${JSON.stringify(job.result)}`);
				strictEqual(job.status, 'COMPLETE', `purge job must COMPLETE, got ${job.status}: ${job.message}`);
				ok(
					Number(job.result?.entries_deleted) > 0,
					`NON-VACUOUS PRECONDITION: the purge must delete audit entries, got entries_deleted=${job.result?.entries_deleted}`
				);
				ok(
					Number(job.result?.log_files_deleted) > 0,
					`NON-VACUOUS PRECONDITION: the purge must delete whole log files — deleting a file is the only thing that could strand the flush position — got log_files_deleted=${job.result?.log_files_deleted}`
				);

				postPurge = await logStats(ctx, 'QuietTarget');

				// Here and nowhere else: after the restart this window is gone. These rows are written by
				// the process that ran the purge — the residual exposure the QA-822 family named.
				await insertRows(ctx, 'QuietTarget', sameProcess.rows);
				await assertMarkersIntact(ctx, '1. POSITIVE CONTROL same-process', sameProcess.rows);

				await restart(ctx, '1.');
				postPurgeRestart = await logStats(ctx, 'QuietTarget');
				findings.push(`1. post-purge ${fmt(postPurge)}`);
				findings.push(`1. post-purge restart ${fmt(postPurgeRestart)}`);
				purged = true;
			}
		);

		test('2. INVARIANT 1: the purge leaves the flush position a sound witness, and the restart appends above it', async () => {
			ok(purged, 'PRECONDITION: the purge must have run before its aftermath is asserted');
			// One claim — the position `txn.state` holds outlived the purge as a usable witness — split so
			// a red run names which of the states it rules out actually happened.
			for (const [when, stats] of [
				['immediately after the purge', postPurge],
				['after the purging process shut down and reopened', postPurgeRestart],
			] as const) {
				assertWitness(
					stats,
					`RETENTION-WITNESS INVARIANT (${when}): a purge may delete every fully flushed log file, the one ` +
						`lastFlushedPosition names included (rocksdb-js#911), but the position itself must stay a sound ` +
						`witness. A stranded position loses everything written before the next flush at shutdown (rocksdb-js#808).`
				);
			}
			ok(
				comparePositions(postPurgeRestart.lastFlushedPosition, postPurge.lastFlushedPosition) >= 0,
				`RETENTION-WITNESS INVARIANT: the flush position must never move backwards across a restart — txn.state ` +
					`only moves forward and load() appends past it. Got post-purge=${fmt(postPurge)} reopened=${fmt(postPurgeRestart)}`
			);
		});

		test(
			'3. ramp: plant markers around the same 260 records written as 260 commits and as 1 commit, then restart once',
			{ timeout: 600_000 },
			async () => {
				ok(purged, 'PRECONDITION: the ramp must run inside the post-purge window');
				await insertRows(ctx, 'QuietTarget', cp0.rows);
				await assertMarkersIntact(ctx, '3. POSITIVE CONTROL cp0', cp0.rows);

				const beforeMany = await logStats(ctx, 'QuietTarget');
				for (const row of shapeRows('sm')) await insertRows(ctx, 'Healer', [row]);
				const afterMany = await logStats(ctx, 'QuietTarget');

				await insertRows(ctx, 'QuietTarget', cp1.rows);
				await assertMarkersIntact(ctx, '3. POSITIVE CONTROL cp1', cp1.rows);

				const beforeOne = await logStats(ctx, 'QuietTarget');
				await insertRows(ctx, 'Healer', shapeRows('lg'));
				const afterOne = await logStats(ctx, 'QuietTarget');

				await insertRows(ctx, 'QuietTarget', cp2.rows);
				await assertMarkersIntact(ctx, '3. POSITIVE CONTROL cp2', cp2.rows);

				// A rotation inside a window would make its offset delta measure the rotation, and a
				// foreign write — an audit-cleanup pass raising the retention floor is the plausible one
				// — would add bytes neither shape asked for. Both would fail invariant 2 for a reason
				// that is not commit grouping, so the entry count rules the second one out here.
				for (const [label, from, to] of [
					['260 single-row commits', beforeMany, afterMany],
					['one 260-row commit', beforeOne, afterOne],
				] as const) {
					strictEqual(
						to.nextLogPosition.sequence,
						from.nextLogPosition.sequence,
						`ORACLE ARMING: ${label} must not rotate the log (${SHAPE_ROWS} rows × ${SHAPE_PAD.length}B is far below maxFileSize=${from.maxFileSize}), got sequence ${from.nextLogPosition.sequence} -> ${to.nextLogPosition.sequence}`
					);
					strictEqual(
						to.entriesWritten - from.entriesWritten,
						SHAPE_ROWS,
						`ORACLE ARMING: ${label} must be the only thing written to the shared log in its window, or the byte delta is not attributable to the records; got ${to.entriesWritten - from.entriesWritten} log entries for ${SHAPE_ROWS} records`
					);
				}
				manyCommitBytes = afterMany.nextLogPosition.offset - beforeMany.nextLogPosition.offset;
				oneCommitBytes = afterOne.nextLogPosition.offset - beforeOne.nextLogPosition.offset;
				findings.push(
					`3. write cursor: ${SHAPE_ROWS} single-row commits advanced it ${manyCommitBytes}B, ` +
						`one ${SHAPE_ROWS}-row commit advanced it ${oneCommitBytes}B`
				);

				await restart(ctx, '3.');
				findings.push(`3. post-ramp restart ${fmt(await logStats(ctx, 'QuietTarget'))}`);
				ramped = true;
			}
		);

		test('4. INVARIANT 2: commit grouping does not change how far the same records advance the log', async () => {
			ok(ramped, 'PRECONDITION: the ramp must have run before its two commit shapes are compared');
			ok(
				manyCommitBytes > 0,
				`ORACLE ARMING: the ${SHAPE_ROWS} single-row commits must advance the write cursor at all, got ${manyCommitBytes}B`
			);
			strictEqual(
				oneCommitBytes,
				manyCommitBytes,
				`COMMIT-GROUPING INVARIANT: ${SHAPE_ROWS} identical records must advance the transaction log by the same bytes however they are grouped into commits — ${SHAPE_ROWS} commits of 1 row moved it ${manyCommitBytes}B, 1 commit of ${SHAPE_ROWS} rows moved it ${oneCommitBytes}B`
			);
		});

		test('5. INVARIANT 3: every marker planted in the post-purge window survives the shutdown', async () => {
			ok(ramped, 'PRECONDITION: the ramp must have run before its checkpoints are read back');
			for (const checkpoint of checkpoints) {
				await assertMarkersIntact(ctx, `5. POST-RESTART ${checkpoint.label}`, checkpoint.rows);
				findings.push(`5. ${checkpoint.label}: ${checkpoint.rows.length}/${checkpoint.rows.length} survived`);
			}
		});

		test(
			'6. arm (QA-1730): seed an isolated database past rotation, purge it, and restart with zero further writes to it',
			{ timeout: 600_000 },
			async () => {
				const seedStart = await logStats(ctx, CLEAN_REOPEN_TABLE, CLEAN_REOPEN_DB);
				const maxFileSize = seedStart.maxFileSize > 0 ? seedStart.maxFileSize : DEFAULT_MAX_FILE_SIZE;
				const seedRows = Math.ceil((maxFileSize * VICTIM_OVERSHOOT) / VICTIM_PAD.length);
				for (let start = 0; start < seedRows; start += VICTIM_BATCH) {
					const records = Array.from({ length: Math.min(VICTIM_BATCH, seedRows - start) }, (_, i) => ({
						id: `rt_${start + i}`,
						seq: start + i,
						marker: VICTIM_PAD,
					}));
					await insertRows(ctx, CLEAN_REOPEN_TABLE, records, CLEAN_REOPEN_DB);
				}

				const rotations = await waitForRotation(ctx, seedStart.rotations, CLEAN_REOPEN_TABLE, CLEAN_REOPEN_DB);
				findings.push(
					`6. seeded ${seedRows} rows x ${VICTIM_PAD.length}B against maxFileSize=${maxFileSize}; rotations ${seedStart.rotations} -> ${rotations}`
				);

				await flushUntilPurgeable(ctx, CLEAN_REOPEN_TABLE, CLEAN_REOPEN_DB);
				const cutoffTimestamp = Date.now();

				const ack = await rawOp(ctx, {
					operation: 'delete_transaction_logs_before',
					database: CLEAN_REOPEN_DB,
					timestamp: cutoffTimestamp,
				});
				strictEqual(
					ack.status,
					200,
					`delete_transaction_logs_before expected 200, got ${ack.status}: ${ack.text.slice(0, 300)}`
				);
				ok(ack.body?.job_id, `delete_transaction_logs_before must return a job_id, got ${ack.text.slice(0, 300)}`);

				const job = await pollJob(ctx, ack.body.job_id);
				findings.push(`6. purge job ${job.status} result=${JSON.stringify(job.result)}`);
				strictEqual(job.status, 'COMPLETE', `purge job must COMPLETE, got ${job.status}: ${job.message}`);
				ok(
					Number(job.result?.entries_deleted) > 0,
					`NON-VACUOUS PRECONDITION: the purge must delete audit entries, got entries_deleted=${job.result?.entries_deleted}`
				);
				ok(
					Number(job.result?.log_files_deleted) > 0,
					`NON-VACUOUS PRECONDITION: the purge must delete whole log files, got log_files_deleted=${job.result?.log_files_deleted}`
				);

				cleanReopenBoundary = await logStats(ctx, CLEAN_REOPEN_TABLE, CLEAN_REOPEN_DB);
				findings.push(`6. boundary (last sample before the no-write restart) ${fmt(cleanReopenBoundary)}`);

				// Nothing below ever writes to CLEAN_REOPEN_DB again — that absence is what makes this
				// restart's reopen sample "clean", unlike invariant 1's second sample.
				await restart(ctx, '6.', () => {
					cleanReopenDiskFiles = diskLogFiles(cleanReopenBoundary.path);
				});

				cleanReopenReopened = await logStats(ctx, CLEAN_REOPEN_TABLE, CLEAN_REOPEN_DB);
				findings.push(`6. reopened (clean, no-write restart) ${fmt(cleanReopenReopened)}`);
				cleanReopened = true;
			}
		);

		test('7. INVARIANT 4 (QA-1730): a clean, write-free reopen leaves the flush position exactly where the purge left it, with txn.state physically on disk and no fully flushed file left behind', () => {
			ok(cleanReopened, 'PRECONDITION: the clean-reopen restart (test 6) must have run first');
			for (const [when, stats] of [
				['immediately after the purge', cleanReopenBoundary],
				['after a clean, write-free restart', cleanReopenReopened],
			] as const) {
				assertWitness(
					stats,
					`CLEAN-REOPEN INVARIANT (${when}): the purge must leave lastFlushedPosition a sound witness, the same ` +
						`contract invariant 1 pins — this is that contract's missing no-write sample.`
				);
			}
			deepStrictEqual(
				cleanReopenReopened.lastFlushedPosition,
				cleanReopenBoundary.lastFlushedPosition,
				`CLEAN-REOPEN INVARIANT: with zero writes to ${CLEAN_REOPEN_DB} between the purge and the restart, the reopened ` +
					`flush position must be byte-identical to the pre-restart position. Got boundary=${fmt(cleanReopenBoundary)} ` +
					`reopened=${fmt(cleanReopenReopened)}`
			);
			// The HTTP samples above only prove the reopened process's own self-report; this proves the
			// witness was actually ON DISK while the process was down, which a clever recomputation on
			// open could satisfy without ever having persisted it, and that the purge applied #911's rule
			// to the files themselves rather than keeping the flushed-position file as #799 did.
			assertPurgeRuleOnDisk(
				cleanReopenDiskFiles,
				cleanReopenBoundary.path,
				cleanReopenBoundary.lastFlushedPosition,
				'CLEAN-REOPEN INVARIANT (on disk, process down)'
			);
		});

		test('8. PREDICATE CONTROL (synthetic inputs, no real crash observed): the graceful-exit check every restart() call runs rejects a nonzero exit, a fatal signal, and a still-running process', () => {
			assertGracefulExit({ exitCode: 0, signalCode: null }, 'sanity: the real graceful shape must still pass');
			throws(
				() => assertGracefulExit({ exitCode: 1, signalCode: null }, 'synthetic nonzero exit'),
				/exitCode:1/,
				'must reject a nonzero exit code'
			);
			throws(
				() => assertGracefulExit({ exitCode: null, signalCode: 'SIGSEGV' }, 'synthetic fatal signal'),
				/SIGSEGV/,
				'must reject a fatal signal'
			);
			throws(
				() => assertGracefulExit({ exitCode: null, signalCode: null }, 'synthetic unresolved (still running)'),
				/exitCode:null signalCode:null/,
				'must reject a process that never reported an exit'
			);
		});
	}
);
