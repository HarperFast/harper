/**
 * This tests that transaction log replay works on crash. There is a bunch of data written to the system
 * database, so replay needs to work for harper to startup.
 */
import { suite, test, before, after } from 'node:test';
import {
	startHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
	killHarper,
} from '@harperfast/integration-testing';
import { ok, deepStrictEqual } from 'node:assert';
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
			}
		);

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
	}
);
