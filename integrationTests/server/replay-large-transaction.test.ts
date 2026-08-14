/**
 * Boot replay of a transaction too large to stage as one in-memory batch (harper#2161).
 *
 * Replay used to commit its transaction only at a version boundary, so every write of one source
 * transaction accumulated in a single batch with no bound at all — a big enough transaction
 * exhausted heap mid-replay, and because the next boot restarts the same replay, the node never
 * came back up. Replay now also commits once the staged batch crosses its size bounds, mid-version.
 *
 * This exercises that mid-version flush on a real crash/replay cycle and asserts the property the
 * flush must not break: a torn-and-recommitted transaction still replays completely. It does not
 * reproduce the OOM itself (that needs a heap-constrained run over GB-scale logs); the bound is
 * covered by unit tests over shouldFlushReplayBatch.
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

suite('Transaction log replay of an oversized transaction', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			env: { HARPER_NO_FLUSH_ON_EXIT: true }, // don't flush on exit; we are simulating a crash
		});
		await op(ctx.harper, { operation: 'create_database', database: DB });
		await op(ctx.harper, { operation: 'create_table', database: DB, table: TABLE, primary_key: 'id' });
	});
	after(async () => teardownHarper(ctx));

	test('replays every record of a transaction larger than one staged batch', async () => {
		const firstLogDir = ctx.harper.logDir;
		const records = [];
		for (let id = 0; id < RECORD_COUNT; id++) records.push({ id, payload: `p${id}`, n: id });
		await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records });

		await new Promise<void>((resolve) => {
			ctx.harper.process.once('exit', () => resolve());
			ctx.harper.process.kill('SIGKILL');
		});
		await startHarper(ctx, { startupTimeoutMs: MAX_REPLAY_STARTUP_MS });

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
});
