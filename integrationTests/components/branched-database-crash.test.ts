/**
 * A branched database must recover its transaction-log tail after a crash (harper#643).
 *
 * A branch's column families write with the WAL disabled, like every store's, so a write's only
 * durable record until the next memtable flush is the branch's own transaction log. A process that
 * dies without flushing — a real crash, or Windows' `taskkill /F`, which runs no exit handlers —
 * must therefore replay that tail when it adopts the branch directory, exactly as a base database
 * does, or the application's most recent writes silently vanish.
 *
 * This is the crash-shaped sibling of branched-database.test.ts's restart test: same fixture, but
 * the restart is a SIGKILL with the exit-time flush disabled (the crash-replay.test.ts pattern), so
 * it reproduces on every platform what the Windows integration shard hits implicitly.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/branched-database-crash.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/branched-database');

const BRANCHED = {
	config: { 'branched-database': { branchedDatabases: ['data'] } },
	// Skip the exit-time RocksDB flush so a kill leaves the branch's last writes only in its
	// transaction log — the state a genuine crash (or a Windows hard kill) leaves behind.
	env: { HARPER_NO_FLUSH_ON_EXIT: 'true' },
};

async function crashHarper(ctx: ContextWithHarper): Promise<void> {
	await new Promise((resolveExit) => {
		ctx.harper!.process!.on('exit', resolveExit);
		ctx.harper!.process!.kill('SIGKILL');
	});
}

suite('an application with a branched database, across a crash', (ctx: ContextWithHarper) => {
	before(async () => {
		// Same two-phase setup as branched-database.test.ts: the base needs the schema before the
		// branch is taken.
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		ctx.harper = { dataRootDir } as any;
		await startHarper(ctx, BRANCHED);
		await sendOperation(ctx.harper, { operation: 'create_database', database: 'data' });
		await sendOperation(ctx.harper, {
			operation: 'create_table',
			database: 'data',
			table: 'Branched',
			primary_key: 'id',
		});
		await sendOperation(ctx.harper, {
			operation: 'insert',
			database: 'data',
			table: 'Branched',
			records: [{ id: 'from-base', note: 'seeded before the branch was taken' }],
		});

		await killHarper(ctx);
		await cp(FIXTURE_PATH, join(dataRootDir, 'components', basename(FIXTURE_PATH)), {
			recursive: true,
			dereference: true,
		});
		await startHarper(ctx, BRANCHED);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test("keeps the application's own data across a crash", async () => {
		await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			action: 'put',
			id: 'crash-survivor',
			note: 'written before the crash',
		});

		await crashHarper(ctx);
		await startHarper(ctx, BRANCHED);

		const recovered = await sendOperation(ctx.harper, { operation: 'branch_probe', id: 'crash-survivor' });
		strictEqual(recovered.found, true, 'a crash must not discard writes the transaction log holds');
		strictEqual(recovered.note, 'written before the crash');

		// Recovery must have replayed the branch's own log into the branch — never into the base.
		const inBase = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			database: 'data',
			table: 'Branched',
			ids: ['crash-survivor'],
			get_attributes: ['id'],
		});
		strictEqual(inBase.length, 0, 'the base must not see the replayed branch write');
	});
});
