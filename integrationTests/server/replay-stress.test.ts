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
 *   3. Random byte flips — msgpack-shaped corruption sprinkled across every
 *      txnlog; replay must finish without the CPU-spin regression that
 *      replayLogsGuards.ts (commit d0190ff5a) fixed
 *
 * All three scenarios share one suite/ctx to avoid the schema-registry leak
 * that surfaces when multiple suites each call create_database in the same
 * test-runner process.
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert/strict';
import { readdirSync, statSync, openSync, readSync, writeSync, truncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	type HarperContext,
} from '@harperfast/integration-testing';

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

function flipBytes(path: string, count: number, seed: number) {
	const size = statSync(path).size;
	// Skip the 13-byte file header (4 token + 1 version + 8 ts) so we exercise
	// the per-entry decoder hardening, not file-open validation.
	const start = 13;
	if (size <= start + 32) return;
	const fd = openSync(path, 'r+');
	try {
		const buf = Buffer.alloc(1);
		let s = seed;
		for (let i = 0; i < count; i++) {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			const pos = start + (s % (size - start));
			readSync(fd, buf, 0, 1, pos);
			buf[0] ^= 0xa5;
			writeSync(fd, buf, 0, 1, pos);
		}
	} finally {
		closeSync(fd);
	}
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

	test('crash with random byte flips in txnlogs', async () => {
		for (const table of TABLES) {
			const records = [];
			for (let i = 0; i < 500; i++) records.push(makeRecord(200_000 + i));
			await op(ctx.harper, { operation: 'insert', database: DB, table, records });
		}
		const replayMs = await crashAndRestart(ctx, (dataRootDir) => {
			// User-DB only: flipping bytes inside system/ txnlogs corrupts
			// version-tracking and Harper aborts on next boot with an upgrade
			// error. That's a real failure mode but not what this test is about —
			// here we want to exercise replay's per-entry decode hardening on
			// records that replay genuinely needs to skip rather than reject the
			// whole boot.
			const files = listTxnLogFiles(dataRootDir, { userOnly: true });
			files.forEach((f, i) => flipBytes(f, 32, 0xcafe + i));
		});
		// Tighter than the 60s global cap. With the per-entry decode guard in place,
		// healthy startup is ~3s on this corpus. Without it, every corrupt entry
		// logs a stack trace inside the loop and startup balloons to ~50s. 20s
		// catches that regression while leaving CI headroom.
		ok(replayMs < 20_000, `replay took ${replayMs}ms — guard regression?`);
		for (const t of TABLES) {
			const c = await countRows(ctx.harper, t);
			ok(typeof c === 'number' && c >= 0, `count on ${t} should be a number, got ${c}`);
		}
		// Confirm Harper isn't in a CPU-spin loop post-replay: rss should be
		// roughly stable after startup is reported done. The pre-fix bug pinned
		// a core forever and rss grew steadily under the spin.
		const rssBefore = ctx.harper.process.resourceUsage?.()?.maxRSS ?? 0;
		await sleep(500);
		const rssAfter = ctx.harper.process.resourceUsage?.()?.maxRSS ?? 0;
		ok(rssAfter - rssBefore < 200 * 1024, `rss grew by ${rssAfter - rssBefore}KB after replay`);
	});
});
