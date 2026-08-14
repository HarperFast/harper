/**
 * Boot replay of a transaction too large to stage as one in-memory batch (harper#2161).
 *
 * Replay used to commit its transaction only at a version boundary, so every write of one source
 * transaction accumulated in a single batch with no bound at all — a big enough transaction
 * exhausted heap mid-replay, and because the next boot restarts the same replay, the node never
 * came back up. Replay now also commits once the staged batch crosses its size bounds, mid-version.
 *
 * These exercise that mid-version commit on real crash/replay cycles and assert the properties it
 * must not break: a torn-and-recommitted transaction still replays completely, and a key written
 * twice in one transaction still ends at its LAST value even when the two writes land in different
 * batches (the committed earlier write ties the later one on version/nodeId, which without
 * `Context.partiallyCommitted` reads as a re-delivered duplicate and is dropped).
 *
 * They do not reproduce the OOM itself (that needs a heap-constrained run over GB-scale logs), and
 * they do not crash BETWEEN two replay batches — the bound is covered by unit tests over
 * shouldFlushReplayBatch, and the re-application of a torn version rests on replay restarting from
 * the log's last-flushed position.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual as equal } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	type HarperContext,
} from '@harperfast/integration-testing';

const DB = 'bigtxn';
const TABLE = 'bigrows';
const REPEAT_TABLE = 'repeatrows';
const REPEAT_ID = 1_000_000;
// Comfortably over REPLAY_MAX_STAGED_WRITES (10,000) so one insert operation — one transaction, one
// version — forces at least one mid-version flush. The log assertion below fails loudly if that
// bound is ever raised past this, rather than silently no longer exercising the flush.
const RECORD_COUNT = 25_000;
const MAX_REPLAY_STARTUP_MS = 120_000;

async function op(ctx: HarperContext, body: any) {
	return await sendOperation(ctx, { ...body, authorization: ctx.admin });
}

// Every hdb.log this instance may have written to. A restart gets a fresh per-start log directory
// from the harness, but Harper keeps logging to the root recorded in the config it persisted on
// first start — so the restart's replay output lands in the FIRST directory, not the current one.
function readHarperLogs(dirs: (string | undefined)[]): string {
	let combined = '';
	for (const dir of dirs) {
		if (!dir) continue;
		try {
			combined += readFileSync(join(dir, 'hdb.log'), 'utf8');
		} catch {
			// a directory that was never written to
		}
	}
	return combined;
}

async function crashAndReplay(ctx: ContextWithHarper) {
	await new Promise<void>((resolve) => {
		ctx.harper.process.once('exit', () => resolve());
		ctx.harper.process.kill('SIGKILL');
	});
	await startHarper(ctx, { startupTimeoutMs: MAX_REPLAY_STARTUP_MS });
}

async function readRepeated(ctx: HarperContext) {
	const rows = await op(ctx, { operation: 'sql', sql: `select n from ${DB}.${REPEAT_TABLE} where id = ${REPEAT_ID}` });
	return rows[0] ?? {};
}

suite('Transaction log replay of an oversized transaction', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			env: { HARPER_NO_FLUSH_ON_EXIT: true }, // don't flush on exit; we are simulating a crash
		});
		await op(ctx.harper, { operation: 'create_database', database: DB });
		for (const table of [TABLE, REPEAT_TABLE]) {
			await op(ctx.harper, { operation: 'create_table', database: DB, table, primary_key: 'id' });
		}
	});
	after(async () => teardownHarper(ctx));

	test('replays every record of a transaction larger than one staged batch', async () => {
		const firstLogDir = ctx.harper.logDir;
		const records = [];
		for (let id = 0; id < RECORD_COUNT; id++) records.push({ id, payload: `p${id}`, n: id });
		await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records });

		await crashAndReplay(ctx);

		const count = await op(ctx.harper, { operation: 'sql', sql: `select count(*) as c from ${DB}.${TABLE}` });
		equal(count[0]?.c ?? count[0]?.['COUNT(*)'], RECORD_COUNT);
		// Spot-check the ends and the middle: a flush that dropped or misordered the tail of a torn
		// batch would still leave the count right if it also replayed something else.
		for (const id of [0, RECORD_COUNT >> 1, RECORD_COUNT - 1]) {
			const found = await op(ctx.harper, {
				operation: 'sql',
				sql: `select id, n from ${DB}.${TABLE} where id = ${id}`,
			});
			equal(found[0]?.n, id, `record ${id} did not replay`);
		}

		const log = readHarperLogs([firstLogDir, ctx.harper.logDir, join(ctx.harper.dataRootDir, 'log')]);
		ok(
			log.includes('intra-transaction batch'),
			'expected replay to report a mid-version flush; the transaction may no longer exceed the staged-batch bound'
		);
	});

	test('a key written twice in one oversized transaction replays to its last value', async () => {
		// Both writes to REPEAT_ID belong to one operation — one transaction, one version — with the
		// batch bound falling between them.
		const records: any[] = [{ id: REPEAT_ID, payload: 'first', n: 1 }];
		for (let id = 1; id <= RECORD_COUNT; id++) records.push({ id, payload: `p${id}`, n: id });
		records.push({ id: REPEAT_ID, payload: 'last', n: 2 });
		await op(ctx.harper, { operation: 'upsert', database: DB, table: REPEAT_TABLE, records });
		equal((await readRepeated(ctx.harper)).n, 2, 'the second write should win before the crash');

		await crashAndReplay(ctx);

		equal((await readRepeated(ctx.harper)).n, 2, 'the second write to the repeated key was lost in replay');
	});

	test('a key patched after an earlier write in the same oversized transaction replays to its last value', async () => {
		const records: any[] = [{ id: REPEAT_ID, n: 3 }];
		for (let id = 1; id <= RECORD_COUNT; id++) records.push({ id, n: id + 1 });
		records.push({ id: REPEAT_ID, n: 4 });
		await op(ctx.harper, { operation: 'update', database: DB, table: REPEAT_TABLE, records });
		equal((await readRepeated(ctx.harper)).n, 4, 'the second patch should win before the crash');

		await crashAndReplay(ctx);

		equal((await readRepeated(ctx.harper)).n, 4, 'the second patch of the repeated key was lost in replay');
	});
});
