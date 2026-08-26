/**
 * A branched application cannot declare its schema into the base (harper#643).
 *
 * GraphQL `@table`, `scope.ensureTable` and `defineTable` all register in the process-wide catalog.
 * For a branched name that means the table would be created in the BASE — replicated, visible to
 * every other application, and bound to this application's own REST routes — while the application's
 * own JavaScript read and wrote its branch. It is refused until harper#2264 makes these land in the
 * branch instead.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/branched-database-schema-gate.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/branched-database-gated');

suite('a branched application declaring a table in the base', (ctx: ContextWithHarper) => {
	before(async () => {
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		ctx.harper = { dataRootDir } as any;
		await startHarper(ctx);
		await sendOperation(ctx.harper, { operation: 'create_database', database: 'data' });
		await sendOperation(ctx.harper, {
			operation: 'create_table',
			database: 'data',
			table: 'Branched',
			primary_key: 'id',
		});
		await killHarper(ctx);
		await cp(FIXTURE_PATH, join(dataRootDir, 'components', basename(FIXTURE_PATH)), {
			recursive: true,
			dereference: true,
		});
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('is refused, so the base schema is untouched', async () => {
		// The fixture's schema.graphql declares `GatedByBranch @table(database: "data")` and the
		// application branches `data`. Dropping `branchedDatabases` from that same fixture is what
		// makes this table appear here, so the assertion is about the gate and not about the
		// application failing to load for some other reason.
		const described = await sendOperation(ctx.harper, { operation: 'describe_database', database: 'data' });
		ok(!Object.keys(described).includes('GatedByBranch'), 'a branched application must not create a base table');

		// It still loads and still reaches its branch: the refusal is scoped to the declaration.
		const probe = await sendOperation(ctx.harper, { operation: 'branch_probe', id: 'anything' });
		ok(probe.found === false, 'the application itself is still running against its branch');
	});
});
