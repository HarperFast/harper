/**
 * Upgrade compatibility tests: v4.x → v5.
 *
 * Tests transaction log replay on crash (data written to system DB before kill),
 * downgrade-and-re-upgrade round-trips, LMDB→RocksDB migration, and v4-specific
 * backward-compat sub-cases (hdb_status GTM table, clustering: config key).
 *
 * ## Version matrix
 *
 * The suite is parameterized by env vars pointing at legacy Harper installations:
 *
 *   HARPER_LEGACY_VERSION_PATH  — primary; maps to "the v4.x build under test" (any minor)
 *   HARPER_LEGACY_V43_PATH      — v4.3.x-specific build (for version-gated sub-tests)
 *   HARPER_LEGACY_V44_PATH      — v4.4.x-specific build
 *   HARPER_LEGACY_V45_PATH      — v4.5.x-specific build
 *   HARPER_LEGACY_V46_PATH      — v4.6.x-specific build
 *   HARPER_LEGACY_V47_PATH      — v4.7.x-specific build
 *
 * To run the matrix in CI, launch once per env var, e.g.:
 *   HARPER_LEGACY_VERSION_PATH=/opt/harper-4.3 npm run test:integration -- upgrade
 *   HARPER_LEGACY_VERSION_PATH=/opt/harper-4.7 npm run test:integration -- upgrade
 *
 * Sub-tests that require a specific minor may use the version-specific var instead
 * of the generic one, and skip when that var is absent.
 */
import { suite, test, before, after } from 'node:test';
import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	killHarper,
} from '@harperfast/integration-testing';
import { ok, deepStrictEqual, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';

const WIDGET_COUNT = 60;
const buildWidgets = () =>
	Array.from({ length: WIDGET_COUNT }, (_, i) => ({
		id: `w-${i}`,
		name: `widget-${i}`,
		category: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C',
		price: Number((9.99 + i).toFixed(2)),
		inStock: i % 2 === 0,
		tags: [`tag${i % 5}`, `bucket${i % 4}`],
	}));

const testsBun = process.env.HARPER_RUNTIME === 'bun';
const legacyPath = process.env.HARPER_LEGACY_VERSION_PATH;
suite(
	'Start 4.x server and test upgrade',
	{ skip: !legacyPath || testsBun || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		const widgets = buildWidgets();

		before(async () => {
			await startHarper(ctx, {
				config: {},
				env: {
					TC_AGREEMENT: 'yes',
					REPLICATION_HOSTNAME: 'localhost',
				},
				harperBinPath: join(legacyPath, 'bin', 'harperdb.js'),
			});
			await sendOperation(ctx.harper, {
				operation: 'create_table',
				table: 'test',
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'name', type: 'String' },
				],
			});
			for (let i = 0; i < 10; i++) {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					table: 'test',
					records: [{ id: 'id-' + i, name: 'test data ' + Math.random() }],
				});
			}
			for (let i = 0; i < 5; i++) {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					table: 'test',
					records: [{ id: 'id-' + Math.floor(Math.random() * 10), name: 'test data ' + Math.random() }],
				});
			}

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
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('upgrade and start', async () => {
			await killHarper(ctx); // kill old 4.x harper
			await startHarper(ctx, { config: {}, env: {} }); // start on v5 (upgrade directives run automatically, no prompt)
			let response = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'test',
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-4' }],
			});
			ok(response.length > 4);
			response = await sendOperation(ctx.harper, {
				operation: 'read_audit_log',
				schema: 'data',
				table: 'test',
			});
			ok(response.length > 10);
		});

		test('downgrade and start', async () => {
			// can we downgrade?
			await killHarper(ctx); // kill 5.x harper
			await startHarper(ctx, {
				config: {},
				env: {
					CONFIRM_DOWNGRADE: 'yes',
				},
				harperBinPath: join(legacyPath, 'bin', 'harperdb.js'),
			}); // start on 4.x again
			let response = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'test',
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-4' }],
			});
			ok(response.length > 4);
			response = await sendOperation(ctx.harper, {
				operation: 'read_audit_log',
				schema: 'data',
				table: 'test',
			});
			ok(response.length > 10);
		});

		test('upgrade and migrate LMDB to RocksDB', async () => {
			await killHarper(ctx);

			const walk = (dir: string, depth = 0, max = 4): string[] => {
				if (depth > max || !existsSync(dir)) return [];
				let entries: string[] = [];
				try {
					for (const name of readdirSync(dir)) {
						const p = join(dir, name);
						try {
							const st = statSync(p);
							entries.push(`${'  '.repeat(depth)}${name}${st.isDirectory() ? '/' : ` (${st.size}b)`}`);
							if (st.isDirectory()) entries = entries.concat(walk(p, depth + 1, max));
						} catch {}
					}
				} catch {}
				return entries;
			};
			console.log(`[precondition] dataRootDir=${ctx.harper.dataRootDir}`);
			console.log(`[precondition] contents:\n${walk(ctx.harper.dataRootDir).join('\n')}`);
			const mdbCandidates = walk(ctx.harper.dataRootDir)
				.filter((line) => line.includes('.mdb') && !line.includes('lock'))
				.map((line) => line.trim().split(' ')[0]);
			console.log(`[precondition] .mdb-ish entries found:`, mdbCandidates);

			const candidateLmdbPaths = [
				join(ctx.harper.dataRootDir, 'database', 'data.mdb'),
				join(ctx.harper.dataRootDir, 'schema', 'data.mdb'),
				join(ctx.harper.dataRootDir, 'database', 'data.mdb', 'data.mdb'),
				join(ctx.harper.dataRootDir, 'schema', 'data', 'data.mdb'),
			];
			const lmdbPath = candidateLmdbPaths.find((p) => existsSync(p));
			if (lmdbPath) {
				console.log(`[precondition] opening LMDB at ${lmdbPath}`);
				const { open: openLmdb } = await import('lmdb');
				const env = openLmdb({ path: lmdbPath, readOnly: true });
				try {
					console.log(`[precondition] DBIs in env:`, [...env.getKeys({ start: undefined, limit: 50 })]);
					const widgetsDbi = env.openDB({ name: 'widgets/', encoding: 'binary' });
					const structuresBuffer = widgetsDbi.getBinary(Symbol.for('structures'));
					console.log(
						`[precondition] widgets shared structures buffer:`,
						structuresBuffer ? `${structuresBuffer.length} bytes` : 'NULL'
					);
					ok(
						structuresBuffer && structuresBuffer.length > 0,
						`source LMDB widgets DBI must have populated shared structures before migration; ` +
							`got ${structuresBuffer ? structuresBuffer.length : 0} bytes. Increase WIDGET_COUNT ` +
							`or widen the record shape so msgpackr promotes the structure into the shared dict.`
					);
				} finally {
					await env.close();
				}
			} else {
				throw new Error(
					`Could not locate the v4 LMDB file. Tried: ${candidateLmdbPaths.join(', ')}. ` +
						`See the directory tree printed above and add the correct path to candidateLmdbPaths.`
				);
			}

			await startHarper(ctx, {
				config: { storage: { migrateOnStart: true } },
				env: {},
			});

			const testTableResponse = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'test',
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-4' }],
			});
			ok(testTableResponse.length > 4);
			ok(existsSync(join(ctx.harper.dataRootDir, 'database', 'data', 'CURRENT')));
			ok(existsSync(join(ctx.harper.dataRootDir, 'database', 'system', 'CURRENT')));

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
					`record ${expected.id} did not round-trip cleanly through migration`
				);
			}

			const byName = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'widgets',
				conditions: [{ attribute: 'name', comparator: 'equals', value: 'widget-7' }],
			});
			ok(
				byName.length === 1 && byName[0].id === 'w-7',
				'index lookup on widgets.name should resolve to w-7 after migration'
			);

			await killHarper(ctx);
			const { RocksDatabase } = await import('@harperfast/rocksdb-js');
			const widgetsCF = RocksDatabase.open(join(ctx.harper.dataRootDir, 'database', 'data'), {
				name: 'widgets/',
				sharedStructuresKey: Symbol.for('structures'),
			});
			try {
				const keys = [...widgetsCF.getKeys()];
				const symbolKeys = keys.filter((k) => typeof k === 'symbol');
				ok(
					symbolKeys.length === 0,
					`widgets/ primary CF must not contain symbol-keyed entries post-migration; found ${symbolKeys.length}: ${symbolKeys.map((s) => s.toString()).join(', ')}`
				);
			} finally {
				widgetsCF.close();
			}
		});

		// Regression test for harper#1260: before the fix, the __dbis__ CF encoder
		// minted own structure IDs (starting at 0x40) that were never persisted on
		// restart → initStores crash-looped with "Data read, but end of buffer not
		// reached 64". Verify that a cold restart after migration decodes all records.
		test('cold restart after LMDB→RocksDB migration reads tables and records', async () => {
			await startHarper(ctx, { config: {}, env: {} });

			const testTableResponse = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'test',
				conditions: [{ attribute: 'id', comparator: 'greater_than', value: 'id-4' }],
			});
			ok(testTableResponse.length > 4, 'test table must have records after cold restart post-migration');

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
					`record ${expected.id} did not survive cold restart post-migration`
				);
			}
		});
	}
);

// ---------------------------------------------------------------------------
// hdb_status GTM table backward-compat
//
// Verifies that a record written to data.hdb_status in v4 is still readable
// via the v5 REST API after upgrade. Uses HARPER_LEGACY_VERSION_PATH (same
// as the primary suite) and is skipped when it is absent.
//
// Note: hdb_status is a system-managed table; not all v4 minor versions expose
// it through the public upsert API. The before() hook skips the upsert when the
// table is absent (table-not-found error), and the test is skipped in that case.
// ---------------------------------------------------------------------------

suite(
	'v4->v5: hdb_status GTM table backward-compat',
	{ skip: !legacyPath || testsBun || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let hdbStatusSeeded = false;

		before(async () => {
			await startHarper(ctx, {
				config: {},
				env: {
					TC_AGREEMENT: 'yes',
					REPLICATION_HOSTNAME: 'localhost',
				},
				harperBinPath: join(legacyPath!, 'bin', 'harperdb.js'),
			});

			// Write a sentinel record to data.hdb_status in v4.
			// Not all v4 builds expose hdb_status via the operations API; if upsert
			// fails with a table-not-found-style error we note it and skip assertion below.
			try {
				await sendOperation(ctx.harper, {
					operation: 'upsert',
					database: 'data',
					table: 'hdb_status',
					records: [{ id: 1, status: 200, message: 'ok' }],
				});
				hdbStatusSeeded = true;
			} catch (err: any) {
				// Table or database absent on this v4 minor — acceptable; the test will skip.
				// v4 reports "not found" for missing tables and "does not exist" for missing databases.
				const msg = String(err?.message ?? err).toLowerCase();
				if (!msg.includes('not found') && !msg.includes('does not exist')) throw err;
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('hdb_status record is readable after upgrade to v5', async (t) => {
			if (!hdbStatusSeeded) {
				t.skip('hdb_status table not available via operations API on this v4 build');
				return;
			}

			await killHarper(ctx);

			// Start v5 on the same dataRootDir — upgrade directives run automatically.
			await startHarper(ctx, { config: {}, env: {} });

			// In v4, hdb_status lived in the data database. v5 may migrate it to system.
			// Try data first; fall back to system so the test covers both locations.
			let rows: any[] | null = null;
			try {
				rows = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					database: 'data',
					table: 'hdb_status',
					conditions: [{ attribute: 'id', comparator: 'equals', value: 1 }],
				});
			} catch {
				// data.hdb_status may have been migrated to system
			}

			if (!rows || rows.length === 0) {
				rows = await sendOperation(ctx.harper, {
					operation: 'search_by_conditions',
					database: 'system',
					table: 'hdb_status',
					conditions: [{ attribute: 'id', comparator: 'equals', value: 1 }],
				});
			}

			ok(
				Array.isArray(rows) && rows.length === 1,
				`expected 1 hdb_status row in data or system after upgrade, got ${JSON.stringify(rows)}`
			);
			strictEqual(rows![0].status, 200, 'hdb_status.status should be 200 after upgrade');
			strictEqual(rows![0].message, 'ok', 'hdb_status.message should be "ok" after upgrade');
		});
	}
);

// ---------------------------------------------------------------------------
// v4.3.x clustering: config key backward-compat
//
// v4.3.x used `clustering: { enabled: true, ... }` in harper.json. v5 renamed
// this key. This test verifies that v5 either migrates the old key gracefully
// or emits an actionable error — it must not crash silently.
//
// Requires HARPER_LEGACY_V43_PATH to point at a v4.3.x installation. Skipped
// when the env var is absent so the CI matrix can omit the v4.3 slot without
// breaking the suite.
// ---------------------------------------------------------------------------

const legacyV43Path = process.env.HARPER_LEGACY_V43_PATH;

suite(
	'v4.3.x→v5: clustering: config key does not cause silent failure',
	{ skip: !legacyV43Path || testsBun || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		before(async () => {
			// Start v4.3.x without any special config — HARPER_SET_CONFIG is a v5
			// mechanism that v4.3 predates, so the clustering key must be injected
			// by writing directly to the on-disk config file after the data dir is
			// created. The first startHarper call just populates ctx.harper.dataRootDir.
			await startHarper(ctx, {
				config: {},
				env: {
					TC_AGREEMENT: 'yes',
					REPLICATION_HOSTNAME: 'localhost',
				},
				harperBinPath: join(legacyV43Path!, 'bin', 'harperdb.js'),
			});

			// Seed a small table so we have something to verify survives.
			await sendOperation(ctx.harper, {
				operation: 'create_table',
				table: 'cluster_compat_test',
				primary_key: 'id',
				attributes: [{ name: 'id', type: 'ID' }],
			});
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'cluster_compat_test',
				records: [{ id: 'sentinel' }],
			});

			// Write the old-style clustering: config key directly into the on-disk
			// config file so that v5 reads it on startup (not v4 — v4 is already up).
			// Different v4.3.x builds may use either filename (harperdb-config.yaml or
			// harper-config.yaml); write to both so the test works regardless of which
			// convention the installed minor uses.
			const legacyConfigPath = join(ctx.harper.dataRootDir, 'harperdb-config.yaml');
			const newConfigPath = join(ctx.harper.dataRootDir, 'harper-config.yaml');

			// Append the old-style clustering block to the existing config file.
			// YAML block append: a trailing newline then a top-level clustering key.
			const clusteringYaml = [
				'',
				'# v4.3 legacy clustering key — injected by upgrade compat test',
				'clustering:',
				'  enabled: true',
				'  nodeName: test-node',
				'  server:',
				'    port: 12345',
				'',
			].join('\n');
			// Write to whichever file(s) exist; create both if neither does so v5 picks
			// up the config regardless of which filename convention is in play.
			for (const configPath of [legacyConfigPath, newConfigPath]) {
				writeFileSync(configPath, clusteringYaml, { flag: 'a' });
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('v5 starts successfully despite old clustering: config key', async () => {
			await killHarper(ctx);

			// startHarper throws HarperStartupError on non-zero exit or timeout.
			// A successful return here means Harper started and is ready — no crash.
			await startHarper(ctx, { config: {}, env: {} });

			ok(
				ctx.harper.process.exitCode === null,
				'v5 Harper process must still be running after startup with old clustering config'
			);

			// Optionally verify seeded data survived: checks data integrity not just
			// startup, but a silent partial-boot (ready signal before tables open)
			// would be caught here.
			const rows = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				table: 'cluster_compat_test',
				conditions: [{ attribute: 'id', comparator: 'equals', value: 'sentinel' }],
			});
			ok(
				Array.isArray(rows) && rows.length === 1,
				`expected sentinel row to survive upgrade, got ${JSON.stringify(rows)}`
			);
		});
	}
);
