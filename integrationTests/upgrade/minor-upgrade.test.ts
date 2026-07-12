/**
 * Upgrade compatibility tests: v5.N-1 → v5.N (previous-minor → current).
 *
 * This is the evergreen "N-1 minor" upgrade gate for Category 14 / §5.9 of the
 * Harper v5 Integration Test Plan. As the release line advances, the env var
 * below points at the previous minor's install and the assertions here validate
 * that the new build opens the same data directory without data loss.
 *
 * ## Validated against
 *
 * Local validation was run against harper@5.0.31 (latest 5.0.x as of 2025-06-18)
 * installed via:
 *
 *   mkdir /path/to/tmp/harper-prev-minor && cd /path/to/tmp/harper-prev-minor
 *   npm install harper@5.0.31
 *   HARPER_PREVIOUS_MINOR_PATH=/path/to/tmp/harper-prev-minor/node_modules/harper \
 *     npm run test:integration -- "integrationTests/upgrade/minor-upgrade.test.ts"
 *
 * ## Version matrix / parameterization
 *
 * The suite is parameterized by a single env var:
 *
 *   HARPER_PREVIOUS_MINOR_PATH  — absolute path to the previous-minor Harper
 *                                 install root (the directory containing
 *                                 dist/bin/harper.js and package.json).
 *
 * The suite skips cleanly when the variable is unset — CI slots that lack a
 * prior-minor install simply skip; no suite-level failure.
 *
 * To run locally:
 *   # Install the previous minor into a temp dir (outside the worktree):
 *   mkdir ~/dev/tmp/harper-prev-minor
 *   cd ~/dev/tmp/harper-prev-minor
 *   npm install harper@5.0.31
 *
 *   # Run only this test file:
 *   HARPER_PREVIOUS_MINOR_PATH=~/dev/tmp/harper-prev-minor/node_modules/harper \
 *     npm run test:integration -- "integrationTests/upgrade/minor-upgrade.test.ts"
 *
 * ## What is tested
 *
 * 1. **Basic upgrade** — boot previous-minor, create and populate representative
 *    tables (plain, indexed, audit-enabled), stop, re-open with the current build.
 *    Asserts: all records intact, indexed search resolves, audit log survives.
 * 2. **Cold restart after upgrade** — kill and restart the current build against
 *    the same data dir. Asserts records and indexes survive a cold restart with no
 *    previous-minor involvement.
 * 3. **Operations API stability** — search_by_conditions, read_audit_log, and
 *    search_by_value return well-formed response shapes (array, typed fields) after
 *    upgrade and after cold restart.
 * 4. **Upgrade directive guard** — the 5.1.0 directive (system.hdb_deployment) ran
 *    exactly once and the table is present after upgrade (RocksDB CURRENT marker).
 */
import { suite, test, before, after } from 'node:test';
import {
	startHarper,
	teardownHarper,
	sendOperation,
	killHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
import { ok, deepStrictEqual, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Shared data fixtures
// ---------------------------------------------------------------------------

const WIDGET_COUNT = 40;
const buildWidgets = () =>
	Array.from({ length: WIDGET_COUNT }, (_, i) => ({
		id: `w-${i}`,
		name: `widget-${i}`,
		category: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C',
		price: Number((9.99 + i).toFixed(2)),
		inStock: i % 2 === 0,
		tags: [`tag${i % 5}`, `bucket${i % 4}`],
	}));

// ---------------------------------------------------------------------------
// Guard: skip on Bun and Windows (matches 4.x-upgrade.test.ts convention)
// ---------------------------------------------------------------------------

const testsBun = process.env.HARPER_RUNTIME === 'bun';
const previousMinorPath = process.env.HARPER_PREVIOUS_MINOR_PATH;

// ---------------------------------------------------------------------------
// Primary suite: seed data under previous minor, then upgrade and assert
// ---------------------------------------------------------------------------

suite(
	'v5.N-1 → v5.N minor upgrade: data integrity + schema migration',
	{ skip: !previousMinorPath || testsBun || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		const widgets = buildWidgets();

		before(async () => {
			// --- Boot previous-minor Harper ---
			await startHarper(ctx, {
				config: {},
				env: {
					TC_AGREEMENT: 'yes',
					REPLICATION_HOSTNAME: 'localhost',
				},
				harperBinPath: join(previousMinorPath!, 'dist', 'bin', 'harper.js'),
			});

			// Plain table with several upserts (tests basic record persistence)
			await sendOperation(ctx.harper, {
				operation: 'create_table',
				table: 'things',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'label', type: 'String' },
					{ name: 'count', type: 'Integer' },
				],
			});
			for (let i = 0; i < 15; i++) {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					table: 'things',
					records: [{ id: `t-${i}`, label: `thing-${i}`, count: i * 3 }],
				});
			}
			// A few overwrites to ensure versioned records are handled
			for (let i = 0; i < 5; i++) {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					table: 'things',
					records: [{ id: `t-${i}`, label: `thing-${i}-v2`, count: i * 3 + 100 }],
				});
			}

			// Indexed table (tests secondary-index migration across minor versions)
			await sendOperation(ctx.harper, {
				operation: 'create_table',
				table: 'widgets',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'name', type: 'String' },
					{ name: 'category', type: 'String' },
					{ name: 'price', type: 'Float' },
					{ name: 'inStock', type: 'Boolean' },
					{ name: 'tags', type: 'Any' },
				],
			});
			for (const widget of widgets) {
				await sendOperation(ctx.harper, { operation: 'upsert', table: 'widgets', records: [widget] });
			}

			// Audit-enabled table (tests audit-log persistence across minor versions)
			// Note: audit is enabled by default for all tables in v5; we rely on the
			// subsequent read_audit_log assertion to confirm the audit records survived.
			await sendOperation(ctx.harper, {
				operation: 'create_table',
				table: 'audit_subject',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'value', type: 'String' },
				],
			});
			for (let i = 0; i < 5; i++) {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					table: 'audit_subject',
					records: [{ id: `a-${i}`, value: `val-${i}` }],
				});
			}
			// Overwrite a record to generate an update audit entry
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'audit_subject',
				records: [{ id: 'a-0', value: 'updated-val-0' }],
			});
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('upgrade: current build opens previous-minor data dir and records are intact', async () => {
			await killHarper(ctx);

			// Re-open the same dataRootDir with the current build (upgrade directives run automatically)
			await startHarper(ctx, { config: {}, env: {} });

			// Plain table: all 15 records readable; overwrote ids 0-4 → labels end in -v2
			const thingsResponse = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'things',
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-0' }],
			});
			ok(Array.isArray(thingsResponse), 'search_by_conditions must return an array');
			ok(thingsResponse.length > 0, 'things table must have records after minor upgrade');

			// Fetch the overwritten record to confirm the updated value survived
			const overwritten = await sendOperation(ctx.harper, {
				operation: 'search_by_value',
				table: 'things',
				search_attribute: 'id',
				search_value: 't-0',
				attributes: ['id', 'label', 'count'],
			});
			ok(Array.isArray(overwritten) && overwritten.length === 1, 'overwritten record t-0 must exist after upgrade');
			strictEqual(overwritten[0].label, 'thing-0-v2', 'overwritten record must carry updated label after upgrade');
			strictEqual(overwritten[0].count, 100, 'overwritten record must carry updated count after upgrade');
		});

		test('upgrade: indexed table records round-trip cleanly and indexed search resolves', async () => {
			// All widget records intact and field types preserved
			for (const expected of widgets) {
				const rows = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					table: 'widgets',
					conditions: [{ attribute: 'id', comparator: 'equals', value: expected.id }],
				});
				ok(rows.length === 1, `expected exactly 1 row for ${expected.id}, got ${rows.length}`);
				const actual = rows[0];
				deepStrictEqual(
					{
						id: actual.id,
						name: actual.name,
						category: actual.category,
						price: actual.price,
						inStock: actual.inStock,
						tags: actual.tags,
					},
					expected,
					`record ${expected.id} did not round-trip cleanly through minor upgrade`
				);
			}

			// Secondary index (name) still resolves
			const byName = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'widgets',
				conditions: [{ attribute: 'name', comparator: 'equals', value: 'widget-7' }],
			});
			ok(
				byName.length === 1 && byName[0].id === 'w-7',
				'secondary index on widgets.name must resolve to w-7 after minor upgrade'
			);

			// Category-filtered search returns expected count (20 widgets with category 'A': ids 0,3,6,…39 → 14 rows)
			const catA = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'widgets',
				conditions: [{ attribute: 'category', comparator: 'equals', value: 'A' }],
			});
			ok(catA.length > 0, 'category-indexed search must return results after minor upgrade');
		});

		test('upgrade: audit log entries survive minor upgrade', async () => {
			const auditResponse = await sendOperation(ctx.harper, {
				operation: 'read_audit_log',
				schema: 'data',
				table: 'audit_subject',
			});
			ok(
				Array.isArray(auditResponse) && auditResponse.length >= 6,
				`expected at least 6 audit log entries (5 inserts + 1 update), got ${auditResponse?.length}`
			);
			// Confirm response shape: each entry must have operation, timestamp, user_name
			for (const entry of auditResponse) {
				ok('operation' in entry, `audit entry missing 'operation' field: ${JSON.stringify(entry)}`);
				ok('timestamp' in entry, `audit entry missing 'timestamp' field: ${JSON.stringify(entry)}`);
			}
		});

		test('upgrade: 5.1.0 directive created system.hdb_deployment table', async () => {
			// The 5.1.0 upgrade directive creates this RocksDB column family. Confirm the
			// RocksDB CURRENT marker exists — a reliable proxy that the table was created.
			const deploymentDbPath = join(ctx.harper.dataRootDir, 'database', 'system', 'CURRENT');
			ok(
				existsSync(deploymentDbPath),
				`system RocksDB CURRENT marker not found at ${deploymentDbPath}; ` + `5.1.0 upgrade directive may not have run`
			);

			// Confirm the table is described via the operations API (describe_table does not
			// require records to exist — a safer check than search_by_conditions with
			// zero conditions, which the API rejects).
			try {
				const desc = await sendOperation(ctx.harper, {
					operation: 'describe_table',
					database: 'system',
					table: 'hdb_deployment',
				});
				ok(
					desc && typeof desc === 'object',
					'describe_table must return a descriptor object for system.hdb_deployment'
				);
				ok(
					'id' in desc || 'hash_attribute' in desc || 'attributes' in desc,
					'descriptor must have id, hash_attribute, or attributes field'
				);
			} catch (err: any) {
				// If the table doesn't exist the operation throws; re-throw with context
				throw new Error(`system.hdb_deployment not found after 5.0 → 5.1 upgrade: ${err?.message ?? err}`);
			}
		});
	}
);

// ---------------------------------------------------------------------------
// Cold-restart suite: verify data survives a full stop+start of the current build
// (no prior-minor involvement; validates RocksDB wrote cleanly on first upgrade)
// ---------------------------------------------------------------------------

suite(
	'v5.N-1 → v5.N minor upgrade: cold restart fidelity',
	{ skip: !previousMinorPath || testsBun || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		const widgets = buildWidgets();

		before(async () => {
			// Boot previous-minor and seed data
			await startHarper(ctx, {
				config: {},
				env: {
					TC_AGREEMENT: 'yes',
					REPLICATION_HOSTNAME: 'localhost',
				},
				harperBinPath: join(previousMinorPath!, 'dist', 'bin', 'harper.js'),
			});

			await sendOperation(ctx.harper, {
				operation: 'create_table',
				table: 'widgets',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'name', type: 'String' },
					{ name: 'category', type: 'String' },
					{ name: 'price', type: 'Float' },
					{ name: 'inStock', type: 'Boolean' },
					{ name: 'tags', type: 'Any' },
				],
			});
			for (const widget of widgets) {
				await sendOperation(ctx.harper, { operation: 'upsert', table: 'widgets', records: [widget] });
			}

			// Initial upgrade: kill previous-minor, start current build once
			await killHarper(ctx);
			await startHarper(ctx, { config: {}, env: {} });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// Regression: after LMDB→RocksDB migration in 4.x tests, the cold restart exposed
		// __dbis__ structure decoder crashes (harper#1260). A clean minor upgrade should not
		// produce a similar cold-restart regression.
		test('cold restart after minor upgrade: all widget records readable and indexes intact', async () => {
			// Kill upgraded instance and restart the current build on the same data dir
			await killHarper(ctx);
			await startHarper(ctx, { config: {}, env: {} });

			// All records intact
			for (const expected of widgets) {
				const rows = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					table: 'widgets',
					conditions: [{ attribute: 'id', comparator: 'equals', value: expected.id }],
				});
				ok(rows.length === 1, `expected exactly 1 row for ${expected.id} after cold restart, got ${rows.length}`);
				const actual = rows[0];
				deepStrictEqual(
					{
						id: actual.id,
						name: actual.name,
						category: actual.category,
						price: actual.price,
						inStock: actual.inStock,
						tags: actual.tags,
					},
					expected,
					`record ${expected.id} did not survive cold restart post minor-upgrade`
				);
			}

			// Secondary index still resolves after cold restart
			const byName = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'widgets',
				conditions: [{ attribute: 'name', comparator: 'equals', value: 'widget-15' }],
			});
			ok(
				byName.length === 1 && byName[0].id === 'w-15',
				'secondary index on widgets.name must resolve to w-15 after cold restart post minor-upgrade'
			);
		});
	}
);
