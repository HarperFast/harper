/**
 * A branched application's schema lands in its branch (harper#2264).
 *
 * GraphQL `@table`, `scope.ensureTable` and `defineTable` all register through the application's
 * own table factory. For a branched name that is the branch's store, so the table the application
 * declares is created in its private fork: served by its exported REST route, reachable through
 * `databases.<name>` from `harper`, and absent from the base -- which every other application and the
 * operations API still see untouched.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/components/branched-database-schema.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, rejects, strictEqual } from 'node:assert';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/branched-database-schema');

// Which databases an application forks is a deployment decision, so it is declared on the
// application's root-config entry, next to host/urlPath — not in its own config.yaml.
const BRANCHED = { config: { 'branched-database-schema': { branchedDatabases: ['data'] } } };

suite('a branched application declaring a table in schema.graphql', (ctx: ContextWithHarper) => {
	let authorization: string;

	before(async () => {
		// The base must exist before it can be branched, so it is built on a first start without the
		// application, and the restart is what branches it.
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
		await killHarper(ctx);
		await cp(FIXTURE_PATH, join(dataRootDir, 'components', basename(FIXTURE_PATH)), {
			recursive: true,
			dereference: true,
		});
		await startHarper(ctx, BRANCHED);
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('serves the table through its exported route, out of the branch', async () => {
		// The fixture's schema.graphql declares `DeclaredInBranch @table(database: "data") @export`.
		const put = await fetch(`${ctx.harper.httpURL}/DeclaredInBranch/via-rest`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', authorization },
			body: JSON.stringify({ note: 'written through the exported route' }),
		});
		strictEqual(put.status, 204, `PUT through the exported route: ${put.status} ${await put.text()}`);

		const get = await fetch(`${ctx.harper.httpURL}/DeclaredInBranch/via-rest`, { headers: { authorization } });
		strictEqual(get.status, 200);
		strictEqual(((await get.json()) as any).note, 'written through the exported route');

		// The same row through `databases.data.DeclaredInBranch` imported from `harper`: the route
		// and the binding resolve to one store, the branch.
		const probe = await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			table: 'DeclaredInBranch',
			id: 'via-rest',
		});
		strictEqual(probe.found, true, 'the imported binding reads what the route wrote');
		strictEqual(probe.note, 'written through the exported route');
	});

	test('the base database has no such table', async () => {
		const described = await sendOperation(ctx.harper, { operation: 'describe_database', database: 'data' });
		ok(!Object.keys(described).includes('DeclaredInBranch'), 'a branched declaration must not create a base table');
		ok(Object.keys(described).includes('Branched'), 'sanity: the base still describes its own table');

		await rejects(
			() =>
				sendOperation(ctx.harper, {
					operation: 'search_by_id',
					database: 'data',
					table: 'DeclaredInBranch',
					ids: ['via-rest'],
					get_attributes: ['*'],
				}),
			/not exist|invalid/i,
			'the operations API resolves the base and must not find the table'
		);
	});

	test("the application's own writes to a base-created table still go to the branch", async () => {
		await sendOperation(ctx.harper, {
			operation: 'branch_probe',
			table: 'Branched',
			action: 'put',
			id: 'app-only',
			note: 'from the application',
		});
		const throughBase = await sendOperation(ctx.harper, {
			operation: 'search_by_id',
			database: 'data',
			table: 'Branched',
			ids: ['app-only'],
			get_attributes: ['*'],
		});
		strictEqual(throughBase.length, 0, 'the base never sees the application’s write');
	});
});
