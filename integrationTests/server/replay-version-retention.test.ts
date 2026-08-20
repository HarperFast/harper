/**
 * EXPERIMENT: does startup transaction-log replay retain a whole same-version run?
 *
 * `replayLogs` opens one `DatabaseTransaction` per audit-entry `version` and commits it only when
 * the version CHANGES (`if (lastTimestamp !== version)`). There are exactly two
 * `directCommitSync()` calls in the file — that version boundary and one after the loop — so there
 * is no mid-version commit and no size cap. Every entry sharing one version therefore stages into a
 * single uncommitted transaction, and each one's value is decoded (`auditRecord.getValue`) before
 * being staged.
 *
 * If that is the retention, replay cost scales with the LARGEST SAME-VERSION RUN rather than with
 * total backlog — which would explain a main-thread heap OOM during recovery on a node whose peer
 * catch-up of a much larger backlog succeeds (the live case: heapUsed +1,867 MB at 72 MB/s, while
 * external/arrayBuffers barely moved).
 *
 * Design: identical record count and payload bytes, replayed under a constrained old-space, differing
 * only in how many versions they span. One Harper `insert` is one transaction, so N records in one
 * insert share one version; N single-record inserts span N versions.
 *
 *   control  small backlog, many versions   -> must restart (proves the ceiling itself is workable)
 *   spread   N records over N versions      -> must restart (proves volume alone is not the problem)
 *   same     N records in ONE version       -> the measurement
 *
 * If `same` fails to restart while `spread` succeeds on the same bytes, per-version batching is the
 * retention. If both succeed, the hypothesis is wrong and the retention is elsewhere.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	type HarperContext,
} from '@harperfast/integration-testing';

const DB = 'replayret';
const TABLE = 'pages';
// ~20 KB per record: large enough that a retained run is visible against a small old-space, small
// enough that the pre-crash insert itself is comfortable.
const PAYLOAD_BYTES = 20_000;
const RECORDS = Number(process.env.HARPER_TEST_REPLAY_RECORDS || '2000');
const OLD_SPACE_MB = process.env.HARPER_TEST_REPLAY_OLD_SPACE_MB || '400';
const MAX_REPLAY_STARTUP_MS = 120_000;

async function op(ctx: HarperContext, body: any) {
	return await sendOperation(ctx, { ...body, authorization: ctx.admin });
}

function makeRecord(id: number) {
	return { id, payload: 'x'.repeat(PAYLOAD_BYTES), n: id };
}

/** Kill uncleanly so the unflushed txnlog tail must be replayed, then restart with a heap ceiling. */
async function crashAndRestart(ctx: ContextWithHarper): Promise<{ ok: boolean; ms: number; fatal?: string }> {
	await new Promise<void>((resolve) => {
		ctx.harper.process.once('exit', () => resolve());
		ctx.harper.process.kill('SIGKILL');
	});
	const start = Date.now();
	try {
		await startHarper(ctx, {
			startupTimeoutMs: MAX_REPLAY_STARTUP_MS,
			env: { HARPER_NO_FLUSH_ON_EXIT: true, NODE_OPTIONS: `--max-old-space-size=${OLD_SPACE_MB}` },
		});
		return { ok: true, ms: Date.now() - start };
	} catch (error) {
		let fatal: string | undefined;
		try {
			const log = readFileSync(join(ctx.harper.dataRootDir, 'log', 'hdb.log'), 'utf8');
			fatal = log
				.split('\n')
				.filter((l) => /FATAL ERROR|mark-compacts|heap out of memory|JavaScript heap/i.test(l))
				.slice(-2)
				.join(' | ');
		} catch {}
		return { ok: false, ms: Date.now() - start, fatal: fatal || String(error).slice(0, 200) };
	}
}

suite('Replay retention: same-version run vs spread versions', { timeout: 900_000 }, (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { env: { HARPER_NO_FLUSH_ON_EXIT: true } });
		await op(ctx.harper, { operation: 'create_database', database: DB });
		await op(ctx.harper, { operation: 'create_table', database: DB, table: TABLE, primary_key: 'id' });
	});
	after(async () => teardownHarper(ctx));

	test('control: a small backlog replays under the heap ceiling', async () => {
		for (let i = 0; i < 20; i++) {
			await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records: [makeRecord(i)] });
		}
		const r = await crashAndRestart(ctx);
		console.log(`  control: restart ok=${r.ok} in ${r.ms}ms${r.fatal ? ` fatal=${r.fatal}` : ''}`);
		ok(r.ok, `the ${OLD_SPACE_MB} MB ceiling cannot even replay a 20-record backlog — raise it: ${r.fatal}`);
	});

	test('spread: N records over N versions replays under the same ceiling', async () => {
		for (let i = 0; i < RECORDS; i++) {
			await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records: [makeRecord(100_000 + i)] });
		}
		const r = await crashAndRestart(ctx);
		console.log(
			`  spread (${RECORDS} records / ${RECORDS} versions, ~${Math.round((RECORDS * PAYLOAD_BYTES) / 1048576)} MB): restart ok=${r.ok} in ${r.ms}ms${r.fatal ? ` fatal=${r.fatal}` : ''}`
		);
		ok(
			r.ok,
			`spread-version replay of the same bytes also failed, so version batching is NOT the discriminator: ${r.fatal}`
		);
	});

	test('same: N records in ONE version', async () => {
		const records = [];
		for (let i = 0; i < RECORDS; i++) records.push(makeRecord(200_000 + i));
		await op(ctx.harper, { operation: 'insert', database: DB, table: TABLE, records });
		const r = await crashAndRestart(ctx);
		console.log(
			`  same (${RECORDS} records / 1 version, ~${Math.round((RECORDS * PAYLOAD_BYTES) / 1048576)} MB): restart ok=${r.ok} in ${r.ms}ms${r.fatal ? ` fatal=${r.fatal}` : ''}`
		);
		// Reported, not asserted: this test exists to measure the difference, and either outcome is a
		// finding. The assertion that matters is that it behaves the SAME as spread.
		ok(
			r.ok,
			`CONFIRMED: replay of ${RECORDS} records in ONE version failed under the same ceiling that ` +
				`replayed the same ${RECORDS} records across ${RECORDS} versions. Replay cost scales with the ` +
				`largest same-version run, not total backlog — per-version transaction batching in replayLogs ` +
				`retains the whole run. fatal=${r.fatal}`
		);
	});
});
