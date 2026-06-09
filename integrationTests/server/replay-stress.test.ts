/**
 * Stress test for transaction-log replay on crash.
 *
 * Complements crash-replay.test.ts (which verifies the system DB replays after
 * a clean SIGKILL on a fresh install) by running a real user workload through
 * three SIGKILL/restart cycles inside one Harper instance:
 *
 *   1. Clean crash — replay must recover every row inserted before SIGKILL
 *   2. Truncated tails — last bytes of each txnlog stripped (simulates a torn
 *      write at the moment of crash); replay must still come back up
 *   3. Corrupt length prefix — the first entry's declared length is forced to
 *      overrun the log (a torn/corrupt frame). rocksdb-js's reader throws a bounded
 *      RangeError for this; replay/broadcast must treat it as end-of-log and the
 *      server must come back up rather than aborting startup (HarperFast/harper#1135)
 *
 * All three scenarios share one suite/ctx to avoid the schema-registry leak
 * that surfaces when multiple suites each call create_database in the same
 * test-runner process.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, openSync, writeSync, truncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	type HarperContext,
} from '@harperfast/integration-testing';
import { constants } from '@harperfast/rocksdb-js';

// Transaction-log framing (all big-endian): a fixed-size file header, then a run of entries
// each shaped [float64 timestamp][uint32 length][flags byte][length bytes of data]. So an
// entry's declared length lives at entryStart + 8, and the byte there is its most-significant.
const { TRANSACTION_LOG_FILE_HEADER_SIZE, TRANSACTION_LOG_ENTRY_HEADER_SIZE } = constants;

const DB = 'stress';
const TABLES = ['orders', 'items', 'events'];
const INSERT_BATCHES = 10;
const BATCH_SIZE = 500;
const UPDATE_PASSES = 5;
const MAX_REPLAY_STARTUP_MS = 60_000;

async function op(ctx: HarperContext, body: any) {
	return await sendOperation(ctx, { ...body, authorization: ctx.admin });
}

async function ensureSchema(ctx: HarperContext) {
	await op(ctx, { operation: 'create_database', database: DB });
	for (const table of TABLES) {
		await op(ctx, { operation: 'create_table', database: DB, table, primary_key: 'id' });
	}
}

function makeRecord(id: number) {
	return {
		id,
		payload: 'x'.repeat(256 + (id % 256)),
		tag: `t${id % 17}`,
		n: id,
	};
}

async function seedAuditVolume(ctx: HarperContext) {
	for (let batch = 0; batch < INSERT_BATCHES; batch++) {
		for (const table of TABLES) {
			const records = [];
			for (let i = 0; i < BATCH_SIZE; i++) {
				records.push(makeRecord(batch * BATCH_SIZE + i));
			}
			await op(ctx, { operation: 'insert', database: DB, table, records });
		}
	}
	for (let pass = 0; pass < UPDATE_PASSES; pass++) {
		for (const table of TABLES) {
			const records = [];
			for (let i = 0; i < BATCH_SIZE; i++) {
				records.push({ id: i, tag: `u${pass}`, payload: 'y'.repeat(128) });
			}
			await op(ctx, { operation: 'update', database: DB, table, records });
		}
	}
	for (const table of TABLES) {
		const ids = [];
		for (let i = 0; i < 100; i++) ids.push(i * 10);
		await op(ctx, { operation: 'delete', database: DB, table, ids });
	}
}

async function countRows(ctx: HarperContext, table: string): Promise<number> {
	const r = await op(ctx, { operation: 'sql', sql: `select count(*) as c from ${DB}.${table}` });
	return r[0]?.c ?? r[0]?.['COUNT(*)'] ?? 0;
}

function listTxnLogFiles(dataRootDir: string, opts?: { userOnly?: boolean }): string[] {
	const out: string[] = [];
	const dbRoot = join(dataRootDir, 'database');
	let dbs: string[];
	try {
		dbs = readdirSync(dbRoot);
	} catch {
		return out;
	}
	for (const db of dbs) {
		if (opts?.userOnly && db === 'system') continue;
		const tlogRoot = join(dbRoot, db, 'transaction_logs');
		let nodes: string[];
		try {
			nodes = readdirSync(tlogRoot);
		} catch {
			continue;
		}
		for (const node of nodes) {
			const nodeDir = join(tlogRoot, node);
			let files: string[];
			try {
				files = readdirSync(nodeDir);
			} catch {
				continue;
			}
			for (const f of files) {
				if (f.endsWith('.txnlog')) out.push(join(nodeDir, f));
			}
		}
	}
	return out;
}

function truncateTail(path: string, bytes: number) {
	const size = statSync(path).size;
	if (size <= bytes + 16) return;
	truncateSync(path, size - bytes);
}

function corruptLastEntryLength(path: string): boolean {
	// Force the *last* well-framed entry's big-endian uint32 length to overrun the log (top
	// byte → 0xff, ≥ 4 GB). The last entry sits in the unflushed tail that replay reads
	// (replay starts from the last-flushed position), so a flushed prefix isn't skipped over.
	const buf = readFileSync(path);
	let pos = TRANSACTION_LOG_FILE_HEADER_SIZE;
	let lastLengthPos = -1;
	while (pos + TRANSACTION_LOG_ENTRY_HEADER_SIZE <= buf.length) {
		if (buf.readDoubleBE(pos) === 0) break; // a zero timestamp marks end-of-log to the reader
		const lengthPos = pos + 8;
		const length = buf.readUInt32BE(lengthPos);
		const next = pos + TRANSACTION_LOG_ENTRY_HEADER_SIZE + length;
		if (length === 0 || next > buf.length) break; // ran past the end / already unframable
		lastLengthPos = lengthPos;
		pos = next;
	}
	if (lastLengthPos < 0) return false;
	const fd = openSync(path, 'r+');
	try {
		writeSync(fd, Buffer.from([0xff]), 0, 1, lastLengthPos);
	} finally {
		closeSync(fd);
	}
	return true;
}

async function crashAndRestart(ctx: ContextWithHarper, mutate?: (dataRootDir: string) => void) {
	const dataRootDir = ctx.harper.dataRootDir;
	await new Promise<void>((resolve) => {
		ctx.harper.process.once('exit', () => resolve());
		ctx.harper.process.kill('SIGKILL');
	});
	if (mutate) mutate(dataRootDir);
	const start = Date.now();
	await startHarper(ctx, { startupTimeoutMs: MAX_REPLAY_STARTUP_MS });
	return Date.now() - start;
}

suite('Transaction log replay stress', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		await ensureSchema(ctx.harper);
	});
	after(async () => teardownHarper(ctx));

	test('clean crash replays all rows', async () => {
		await seedAuditVolume(ctx.harper);
		const before = await Promise.all(TABLES.map((t) => countRows(ctx.harper, t)));
		const replayMs = await crashAndRestart(ctx);
		ok(replayMs < MAX_REPLAY_STARTUP_MS, `replay took ${replayMs}ms`);
		const after = await Promise.all(TABLES.map((t) => countRows(ctx.harper, t)));
		for (let i = 0; i < TABLES.length; i++) {
			equal(after[i], before[i], `row count mismatch on ${TABLES[i]} (before=${before[i]} after=${after[i]})`);
		}
	});

	test('crash with truncated txnlog tails', async () => {
		// Add more audit volume on top of what test 1 left
		for (const table of TABLES) {
			const records = [];
			for (let i = 0; i < 500; i++) records.push(makeRecord(100_000 + i));
			await op(ctx.harper, { operation: 'insert', database: DB, table, records });
		}
		const replayMs = await crashAndRestart(ctx, (dataRootDir) => {
			for (const f of listTxnLogFiles(dataRootDir)) truncateTail(f, 64);
		});
		ok(replayMs < MAX_REPLAY_STARTUP_MS, `replay took ${replayMs}ms`);
		for (const t of TABLES) {
			const c = await countRows(ctx.harper, t);
			ok(typeof c === 'number' && c >= 0, `count on ${t} should be a number, got ${c}`);
		}
	});

	test('crash with corrupt length-prefix recovers without aborting startup', async () => {
		for (const table of TABLES) {
			const records = [];
			for (let i = 0; i < 500; i++) records.push(makeRecord(200_000 + i));
			await op(ctx.harper, { operation: 'insert', database: DB, table, records });
		}
		let corrupted = 0;
		await crashAndRestart(ctx, (dataRootDir) => {
			// User-DB only: corrupting system/ txnlogs trips the upgrade-abort path on next
			// boot — a different failure mode than the framing corruption (#1135) under test.
			for (const f of listTxnLogFiles(dataRootDir, { userOnly: true })) {
				if (corruptLastEntryLength(f)) corrupted++;
			}
		});
		// Fail loudly, not vacuously, if the framing ever changes and nothing gets corrupted.
		ok(corrupted > 0, 'expected to corrupt at least one user-DB txnlog');
		// Behavioral, not a wall-clock budget: crashAndRestart resolved → the server came back
		// up; a regression shows up as a failed restart, not a slow one. Confirm tables queryable.
		for (const t of TABLES) {
			const c = await countRows(ctx.harper, t);
			ok(typeof c === 'number' && c >= 0, `count on ${t} should be a number, got ${c}`);
		}
	});
});
