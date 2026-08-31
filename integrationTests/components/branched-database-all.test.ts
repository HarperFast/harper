/**
 * `branchedDatabases: true`, end to end (harper#643).
 *
 * An application can declare a branch of every database on the instance without naming them, which
 * matters for exactly the case this feature is for: a QA/testing app using several databases
 * shouldn't have to enumerate and maintain that list as schema evolves elsewhere on the instance.
 *
 * Two things this proves that the single-database test does not:
 *   1. `true` really does reach every database that exists at load — not just one the app happens
 *      to name.
 *   2. It is a snapshot, not a subscription: a database created AFTER the application has already
 *      loaded is not retroactively branched. The application's own reads and writes against it fall
 *      straight through to the base, because nothing put it in the scoped bindings' branch map.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/branched-database-all.test.ts"
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

// The same fixture as the single-database test — only the root-config declaration differs.
const BRANCH_ALL = { config: { 'branched-database': { branchedDatabases: true } } };

async function seedDatabase(ctx: ContextWithHarper, database: string, id: string, note: string): Promise<void> {
	await sendOperation(ctx.harper, { operation: 'create_database', database });
	await sendOperation(ctx.harper, { operation: 'create_table', database, table: 'Branched', primary_key: 'id' });
	await sendOperation(ctx.harper, { operation: 'insert', database, table: 'Branched', records: [{ id, note }] });
}

suite('an application with `branchedDatabases: true`', (ctx: ContextWithHarper) => {
	before(async () => {
		// Phase 1 — build two bases the application never named, so branching both proves `true`
		// reaches every database rather than one the app happens to know about.
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		ctx.harper = { dataRootDir } as any;
		await startHarper(ctx, BRANCH_ALL);
		await seedDatabase(ctx, 'data', 'from-base', 'seeded in data before the branch was taken');
		await seedDatabase(ctx, 'extra', 'from-base', 'seeded in extra before the branch was taken');

		// Phase 2 — add the application and restart. Both databases now have schema and rows, so both
		// branch cleanly.
		await killHarper(ctx);
		await cp(FIXTURE_PATH, join(dataRootDir, 'components', basename(FIXTURE_PATH)), {
			recursive: true,
			dereference: true,
		});
		await startHarper(ctx, BRANCH_ALL);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('branches a database the application never named', async () => {
		const result = await sendOperation(ctx.harper, { operation: 'branch_probe', database: 'extra', id: 'from-base' });
		strictEqual(result.found, true, 'extra was branched even though nothing declared it by name');
	});

	test("that database's writes never reach its base either", async () => {
		await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			database: 'extra',
			action: 'put',
			id: 'app-only',
			note: 'written in the extra branch',
		});
		const throughBase = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			database: 'extra',
			table: 'Branched',
			ids: ['app-only'],
			get_attributes: ['id'],
		});
		strictEqual(throughBase.length, 0, 'the base for extra never sees it, same as data');
	});

	test('a database created after the application already loaded is NOT retroactively branched', async () => {
		// `true` is resolved once, before this application's modules import. Nothing watches for a
		// database that appears afterward, so the application's own `databases.late` must fall through
		// to the real (base) database rather than resolving to a branch that was never created.
		await seedDatabase(ctx, 'late', 'seed', 'created after the application had already loaded');

		await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			database: 'late',
			action: 'put',
			id: 'through-app',
			note: 'written through the running application',
		});

		const throughBase = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			database: 'late',
			table: 'Branched',
			ids: ['through-app'],
			get_attributes: ['id'],
		});
		strictEqual(
			throughBase.length,
			1,
			'a write the application made must land in the base: it never got a branch, and falling ' +
				'back silently is the one outcome this feature exists to prevent everywhere else'
		);
	});
});
