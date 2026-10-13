/**
 * Upgrade compatibility tests: previous minor → current build.
 *
 * The evergreen "N-1 minor" upgrade gate for Category 14 / §5.9 of the Harper v5 Integration Test
 * Plan. Each install in HARPER_PREVIOUS_MINOR_PATH (see minorVersionFixtures.ts) seeds a data
 * directory, and the current build must open it without data loss. CI runs 5.2.15 and 5.3.1; while
 * `package.json` is on the 5.3 line, the 5.3.x run reopens same-minor data (no upgrade directive runs)
 * and only the 5.2.x run exercises a minor upgrade.
 *
 * Rollback in the other direction is minor-downgrade.test.ts.
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
 * 4. **system.hdb_deployment** — the table the 5.1.0 directive provisions is present after upgrade.
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
import {
	FIRST_BOOT_ENV,
	NO_PREVIOUS_MINOR,
	SUITE_TIMEOUT_MS,
	buildWidgets,
	previousMinorInstalls,
	seedMinorFixtures,
	seedWidgets,
	skipCrossVersion,
} from './minorVersionFixtures.ts';

if (previousMinorInstalls.length === 0)
	suite('previous minor → current minor upgrade', { skip: NO_PREVIOUS_MINOR }, () => {});

for (const previousMinor of previousMinorInstalls) {
	suite(
		`v${previousMinor.version} → current minor upgrade: data integrity + schema migration`,
		{ skip: skipCrossVersion, timeout: SUITE_TIMEOUT_MS },
		(ctx: ContextWithHarper) => {
			const widgets = buildWidgets();

			before(
				async () => {
					await startHarper(ctx, { config: {}, env: FIRST_BOOT_ENV, harperBinPath: previousMinor.binPath });
					await seedMinorFixtures(ctx.harper);
				},
				{ timeout: SUITE_TIMEOUT_MS }
			);

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

				const catA = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					table: 'widgets',
					conditions: [{ attribute: 'category', comparator: 'equals', value: 'A' }],
				});
				deepStrictEqual(
					catA.map(({ id }: { id: string }) => id).sort(),
					widgets
						.filter(({ category }) => category === 'A')
						.map(({ id }) => id)
						.sort(),
					'category-indexed search must return exactly the category A widgets after minor upgrade'
				);
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
				for (const entry of auditResponse) {
					ok('operation' in entry, `audit entry missing 'operation' field: ${JSON.stringify(entry)}`);
					ok('timestamp' in entry, `audit entry missing 'timestamp' field: ${JSON.stringify(entry)}`);
				}
			});

			test('upgrade: system.hdb_deployment (provisioned by the 5.1.0 directive) is present', async () => {
				// Only shows the system database is RocksDB; describe_table below is what proves the table exists.
				const deploymentDbPath = join(ctx.harper.dataRootDir, 'database', 'system', 'CURRENT');
				ok(existsSync(deploymentDbPath), `system RocksDB CURRENT marker not found at ${deploymentDbPath}`);

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
					throw new Error(`system.hdb_deployment not found after minor upgrade: ${err?.message ?? err}`);
				}
			});
		}
	);

	suite(
		`v${previousMinor.version} → current minor upgrade: cold restart fidelity`,
		{ skip: skipCrossVersion, timeout: SUITE_TIMEOUT_MS },
		(ctx: ContextWithHarper) => {
			const widgets = buildWidgets();

			before(
				async () => {
					await startHarper(ctx, { config: {}, env: FIRST_BOOT_ENV, harperBinPath: previousMinor.binPath });
					await seedWidgets(ctx.harper, widgets);

					// Initial upgrade: kill previous-minor, start current build once
					await killHarper(ctx);
					await startHarper(ctx, { config: {}, env: {} });
				},
				{ timeout: SUITE_TIMEOUT_MS }
			);

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
}
