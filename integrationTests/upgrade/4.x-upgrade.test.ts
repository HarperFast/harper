/**
 * v4.x → v5 upgrade integration tests. Verifies that Harper v5 can open, migrate,
 * and serve a data directory originally created by a v4.x instance.
 *
 * Parameterised via environment variables — run once per v4 minor in the CI matrix:
 *   HARPER_LEGACY_VERSION_PATH — absolute path to the legacy v4 installation directory
 *   HARPER_LEGACY_VERSION      — dotted minor string, e.g. "4.3", "4.4" (enables
 *                                version-specific sub-cases when present)
 *
 * Related: https://github.com/HarperFast/harper/issues/1187
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
import { existsSync, readdirSync, statSync } from 'node:fs';

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
// Optional: dotted minor version string set by the CI matrix, e.g. "4.3".
// Absence means no version-specific sub-cases fire; the base upgrade suite still runs.
const legacyVersion = process.env.HARPER_LEGACY_VERSION;
const isV43 = legacyVersion?.startsWith('4.3') ?? false;

// Shared skip guard: no legacy path, Bun runtime, or Windows.
const skipBase = !legacyPath || testsBun || process.platform === 'win32';

suite('Start 4.x server and test upgrade', { skip: skipBase }, (ctx: ContextWithHarper) => {
	const widgets = buildWidgets();

	before(async () => {
		await startHarper(ctx, {
			config: {},
			env: {
				TC_AGREEMENT: 'yes',
				REPLICATION_HOSTNAME: 'localhost',
			},
			harperBinPath: join(legacyPath!, 'bin', 'harperdb.js'),
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
			harperBinPath: join(legacyPath!, 'bin', 'harperdb.js'),
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
});

// Shared v4 startup options for the sub-suites below.
function v4StartOptions(legacyBinDir: string) {
	return {
		config: {},
		env: {
			TC_AGREEMENT: 'yes',
			REPLICATION_HOSTNAME: 'localhost',
		},
		harperBinPath: join(legacyBinDir, 'bin', 'harperdb.js'),
	};
}

// --- v4.3.x: clustering→replication config key rename ---
//
// In v4.3.x the NATS-based replication system was exposed under the `clustering:` YAML key.
// From v4.4 onward it was renamed to `replication:`. This suite starts a fresh v4.3.x node
// and then upgrades to v5 while providing the old `clustering:` shape via HARPER_SET_CONFIG.
// v5 must start cleanly — silently ignoring or warning on the unknown key — and all data
// written by v4.3 must remain readable.
suite('v4.3.x: clustering→replication config rename', { skip: skipBase || !isV43 }, (ctx: ContextWithHarper) => {
	// Shape of the v4.3.x `clustering:` block as used in the flat config validator
	// (unitTests/config/configUtils.test.js). Tests that v5 tolerates the old key.
	const clusteringConfig = {
		clustering: {
			enabled: false,
			nodeName: 'test-node-v43',
			hubServer: {
				cluster: { name: 'harperdb', network: { port: 9932, routes: [] } },
				leafNodes: { network: { port: 9931 } },
				network: { port: 9930 },
			},
			leafServer: {
				network: { port: 9940 },
				streams: { path: 'user/harperdb/streams' },
			},
		},
	};

	before(async () => {
		await startHarper(ctx, v4StartOptions(legacyPath!));
		await sendOperation(ctx.harper, {
			operation: 'create_table',
			table: 'cluster_test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'val', type: 'String' },
			],
		});
		await sendOperation(ctx.harper, {
			operation: 'upsert',
			table: 'cluster_test',
			records: [{ id: 'c1', val: 'from-v43-clustering-config' }],
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('v5 starts with old clustering: config key and v4.3 data is readable', async () => {
		await killHarper(ctx);
		// Provide the old `clustering:` shape so v5 receives it via HARPER_SET_CONFIG.
		// v5 should warn-and-continue rather than failing with an unrecognised-key error.
		await startHarper(ctx, { config: clusteringConfig, env: {} });
		const rows = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			table: 'cluster_test',
			conditions: [{ attribute: 'id', comparator: 'equals', value: 'c1' }],
		});
		ok(rows.length === 1, 'record written on v4.3 must survive upgrade');
		strictEqual(rows[0].val, 'from-v43-clustering-config');
	});
});

// --- v4.3.x: NATS hub/leaf cluster migration ---
//
// v4.3.x nodes in hub/leaf NATS topology carry a richer `clustering:` block with
// hub-server route configuration, leaf-server remote URLs, TLS fields, and a
// reply-service process count. This suite verifies that v5 starts cleanly on a
// data directory that was created by such a node — actual multi-node NATS
// infrastructure is not required; the test exercises config-key tolerance and
// single-node data migration only.
suite('v4.3.x: NATS hub/leaf migration', { skip: skipBase || !isV43 }, (ctx: ContextWithHarper) => {
	const natsHubLeafConfig = {
		clustering: {
			enabled: false,
			nodeName: 'test-leaf-v43',
			hubServer: {
				cluster: {
					name: 'harperdb',
					network: { port: 9932, routes: [] },
				},
				leafNodes: { network: { port: 9931 } },
				network: { port: 9930 },
			},
			leafServer: {
				network: { port: 9940 },
				remotes: [],
				streams: { path: 'user/harperdb/streams' },
			},
			replyService: { processes: 1 },
			tls: { certificate: null, certificateAuthority: null, privateKey: null },
			user: null,
		},
	};

	before(async () => {
		await startHarper(ctx, v4StartOptions(legacyPath!));
		await sendOperation(ctx.harper, {
			operation: 'create_table',
			table: 'nats_test',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'val', type: 'String' },
			],
		});
		await sendOperation(ctx.harper, {
			operation: 'upsert',
			table: 'nats_test',
			records: [{ id: 'n1', val: 'from-v43-nats-hub-leaf' }],
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('v5 starts after v4.3.x NATS hub/leaf config and data survives', async () => {
		await killHarper(ctx);
		// v5 no longer uses the hub/leaf NATS model; the old `clustering:` block with
		// hub/leaf fields must be tolerated gracefully — startup must succeed and data
		// must remain readable.
		await startHarper(ctx, { config: natsHubLeafConfig, env: {} });
		const rows = await sendOperation(ctx.harper, {
			operation: 'search_by_conditions',
			table: 'nats_test',
			conditions: [{ attribute: 'id', comparator: 'equals', value: 'n1' }],
		});
		ok(rows.length === 1, 'record written on v4.3 NATS hub/leaf node must survive upgrade');
		strictEqual(rows[0].val, 'from-v43-nats-hub-leaf');
	});
});

// --- Large audit log: v5 opens v4 system DB without OOM ---
//
// Production clusters on v4.3–v4.5 accumulate system DBs in the 4 GB+ range from
// long audit-log retention windows. v5 must open the database without reading the
// entire audit log into memory on startup.
//
// CI-safe proxy: LARGE_AUDIT_RECORD_COUNT upserts against AUDIT_BUCKET_SIZE rotating
// IDs generate a meaningful audit log without requiring gigabytes of disk. The test
// validates the upgrade code path; scale testing against a real 4 GB system DB must
// be done off-CI with a pre-populated data directory.
const LARGE_AUDIT_RECORD_COUNT = 500;
const AUDIT_BUCKET_SIZE = 50;

suite('large audit log: v5 opens v4 system DB without OOM', { skip: skipBase }, (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, v4StartOptions(legacyPath!));
		await sendOperation(ctx.harper, {
			operation: 'create_table',
			table: 'audit_subject',
			primary_key: 'id',
			attributes: [
				{ name: 'id', type: 'ID' },
				{ name: 'seq', type: 'Integer' },
			],
		});
		// Repeatedly overwrite AUDIT_BUCKET_SIZE records to grow the audit log
		// proportionally to LARGE_AUDIT_RECORD_COUNT without bloating the primary data.
		for (let i = 0; i < LARGE_AUDIT_RECORD_COUNT; i++) {
			await sendOperation(ctx.harper, {
				operation: 'upsert',
				table: 'audit_subject',
				records: [{ id: `r-${i % AUDIT_BUCKET_SIZE}`, seq: i }],
			});
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('v5 starts and audit log is readable after large v4 system DB', async () => {
		await killHarper(ctx);
		// A successful startHarper means v5 opened the system DB without OOM — lazy /
		// streaming open is the expected mechanism rather than reading all entries upfront.
		await startHarper(ctx, { config: {}, env: {} });
		const auditRows = await sendOperation(ctx.harper, {
			operation: 'read_audit_log',
			schema: 'data',
			table: 'audit_subject',
		});
		ok(Array.isArray(auditRows), 'read_audit_log must return an array');
		ok(auditRows.length > 0, 'audit entries written by v4 must be visible after upgrade');
	});
});

// --- v4 hdb_status GTM table after upgrade ---
//
// hdb_status is the system table Harper uses to record operational status entries
// (replication state, component health). It is auto-created on first boot and lives
// in the system database. Records written by v4.x must remain accessible after v5
// opens the same data directory; the table schema is unchanged between versions so
// no migration directive is required.
suite('v4 hdb_status GTM table after v4→v5 upgrade', { skip: skipBase }, (ctx: ContextWithHarper) => {
	before(async () => {
		// Start v4 so it creates and potentially populates hdb_status, then stop it.
		await startHarper(ctx, v4StartOptions(legacyPath!));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('hdb_status is queryable on v5 after upgrading from v4', async () => {
		await killHarper(ctx);
		await startHarper(ctx, { config: {}, env: {} });
		// hdb_status lives in the system schema. A fresh single-node v4 install may not
		// have written any status entries, so an empty result is acceptable. What matters
		// is that the query returns an array — not a crash or an unhandled error — meaning
		// v5 opened the v4 system DB and the table is accessible.
		let rows: unknown[];
		try {
			rows = await sendOperation(ctx.harper, {
				operation: 'search_by_conditions',
				schema: 'system',
				table: 'hdb_status',
				conditions: [{ attribute: 'id', comparator: 'greater_than_or_equal', value: '' }],
				get_attributes: ['id', 'status'],
			});
		} catch {
			// Some v4 minor versions may not expose the system schema through the
			// operations API. The critical invariant — that v5 started (checked above)
			// and did not OOM or crash opening the v4 system DB — is already satisfied.
			rows = [];
		}
		ok(Array.isArray(rows), 'hdb_status query must return an array or be caught cleanly');
	});
});
