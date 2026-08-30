/**
 * Branched databases, end to end (harper#643).
 *
 * An application declares `branchedDatabases: [data]` and its code is unchanged — it still reads
 * and writes `databases.data.Branched`. What this proves is that those names resolve to a private
 * fork: the application starts from the base's rows, and from then on writes cross in neither
 * direction.
 *
 * Two phases, because a branch is a checkpoint: the base must already hold the schema when the
 * branch is taken. The first start creates `Branched` in the base (the application's own
 * `@table` still registers there — scoping that is #2264) and seeds it; the restart is the one
 * that branches a base with data in it.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/branched-database.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { existsSync } from 'node:fs';
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

// Which databases an application forks is a deployment decision, so it is declared on the
// application's root-config entry, next to host/urlPath — not in its own config.yaml.
const BRANCHED = { config: { 'branched-database': { branchedDatabases: ['data'] } } };

suite('an application with a branched database', (ctx: ContextWithHarper) => {
	before(async () => {
		// Phase 1 — no application yet, because one that declares a branch of a database that does not
		// exist is refused. Build the base first: the database, the table, and a row.
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

		// Phase 2 — add the application and restart. The branch is taken against a base that now has
		// the table and the row.
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

	test('starts from the base rows', async () => {
		const result = await sendOperation(ctx.harper, { operation: 'branch_probe', id: 'from-base' });
		strictEqual(result.found, true, 'a branch is a checkpoint of the base, so the base row is there');
		strictEqual(result.note, 'seeded before the branch was taken');
	});

	test("the application's writes never reach the base", async () => {
		await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			action: 'put',
			id: 'app-only',
			note: 'written in branch',
		});
		const throughBranch = await sendOperation(ctx.harper, { operation: 'branch_probe', id: 'app-only' });
		strictEqual(throughBranch.found, true, 'the application reads its own write back');

		const throughBase = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			database: 'data',
			table: 'Branched',
			ids: ['app-only'],
			get_attributes: ['id'],
		});
		strictEqual(throughBase.length, 0, 'and the base never sees it');
	});

	test('writes to the base never reach the application', async () => {
		await sendOperation(ctx.harper, {
			operation: 'insert',
			database: 'data',
			table: 'Branched',
			records: [{ id: 'base-only', note: 'written after the branch was taken' }],
		});
		const result = await sendOperation(ctx.harper, { operation: 'branch_probe', id: 'base-only' });
		strictEqual(result.found, false, 'a branch does not track the base after it is taken');
	});

	test('lives at a path derived only from the application and database names', () => {
		// Deterministic on purpose: every node in a cluster resolves the same application's branch to
		// the same place, which is what lets the branch be addressed -- and eventually replicated --
		// cluster-wide. Nothing process-local (a pid, a run id) may appear in it.
		const branchPath = resolve(ctx.harper!.dataRootDir, 'database', '`branches`', 'branched-database', 'data');
		ok(existsSync(branchPath), `expected the branch at ${branchPath}`);
	});

	test("keeps the application's own data across a restart", async () => {
		// A branch is durable, not scratch: the second start adopts the directory the first one made
		// rather than re-checkpointing over it, so what the application wrote is still its own.
		await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			action: 'put',
			id: 'survives-restart',
			note: 'written before the restart',
		});

		await killHarper(ctx);
		await startHarper(ctx, BRANCHED);

		const after = await sendOperation(ctx.harper, { operation: 'branch_probe', id: 'survives-restart' });
		strictEqual(after.found, true, 'a restart must not discard the branch');
		strictEqual(after.note, 'written before the restart');

		// And it is still a branch, not the base: the restart must not have quietly reattached it.
		const inBase = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			database: 'data',
			table: 'Branched',
			ids: ['survives-restart'],
			get_attributes: ['id'],
		});
		strictEqual(inBase.length, 0, 'and the base still must not see it');
	});
});
