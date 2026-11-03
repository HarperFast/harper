/**
 * `drop_attribute` on a dynamic (`create_table`, no attributes) table rewrites every row without the
 * dropped value. Every row must stay readable with its remaining fields and its version, and a deleted
 * row must stay deleted. A raw primary-store rewrite failed both: RocksDB read 200 → 200 → 0 rows over
 * two drops (harper#1762), and a deleted row came back as `{}`. A probe re-registers each dropped
 * catalog field so projection cannot hide a value the strip left stored.
 *
 *   npm run test:integration -- "integrationTests/database/drop-attribute-dynamic-rewrite.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/drop-attribute-dynamic-rewrite.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const DATABASE = 'drop_attr';
const ROWS = 200;
const FIELDS = ['code', 'name', 'price', 'qty'];

const ids = Array.from({ length: ROWS }, (_, index) => `code-${index}`);
const seedRecord = (index: number) => ({
	code: `code-${index}`,
	name: `name-${index}`,
	price: index * 1.5,
	qty: index,
});

suite('drop_attribute rewrite on a dynamic table keeps every row', (ctx: ContextWithHarper) => {
	const op = (body: Record<string, unknown>) => sendOperation(ctx.harper, body);
	const readAll = (table: string): Promise<any[]> =>
		op({ operation: 'search_by_id', database: DATABASE, table, ids, get_attributes: ['*'] });
	const recordCount = async (table: string): Promise<number> =>
		(await op({ operation: 'describe_table', database: DATABASE, table })).record_count;
	const dropThenRestoreCatalogAttribute = async (table: string, attribute: string) => {
		await op({ operation: 'drop_attribute', database: DATABASE, table, attribute });
		const id = `catalog-probe-${attribute}`;
		await op({ operation: 'insert', database: DATABASE, table, records: [{ code: id, [attribute]: 0 }] });
		await op({ operation: 'delete', database: DATABASE, table, ids: [id] });
		const description = await op({ operation: 'describe_table', database: DATABASE, table });
		strictEqual(
			description.attributes.some((entry: { attribute: string }) => entry.attribute === attribute),
			true
		);
	};
	const updatedTimes = new Map<string, Map<string, number>>();

	async function seed(table: string, deletedIds: string[] = []) {
		await op({ operation: 'create_table', database: DATABASE, table, primary_key: 'code' });
		await op({ operation: 'insert', database: DATABASE, table, records: ids.map((_, index) => seedRecord(index)) });
		if (deletedIds.length) await op({ operation: 'delete', database: DATABASE, table, ids: deletedIds });
		const rows = await readAll(table);
		strictEqual(rows.length, ROWS - deletedIds.length);
		updatedTimes.set(table, new Map(rows.map((row) => [row.code, row.__updatedtime__])));
	}

	async function assertRows(table: string, keptFields: string[], expectedIds: string[]) {
		const rows = await readAll(table);
		strictEqual(rows.length, expectedIds.length, 'search_by_id lost or resurrected rows');
		strictEqual(await recordCount(table), expectedIds.length, 'describe_table record_count lost or resurrected rows');
		deepStrictEqual(rows.map((row) => row.code).sort(), [...expectedIds].sort());
		for (const row of rows) {
			const seeded = seedRecord(Number(row.code.slice('code-'.length)));
			const stored = Object.fromEntries(FIELDS.map((field) => [field, row[field] ?? undefined]));
			const expected = Object.fromEntries(
				FIELDS.map((field) => [field, keptFields.includes(field) ? seeded[field] : undefined])
			);
			deepStrictEqual(stored, expected, `row ${row.code}`);
			strictEqual(row.__updatedtime__, updatedTimes.get(table).get(row.code), `row ${row.code} version changed`);
		}
	}

	before(async () => {
		await startHarper(ctx, { config: { logging: { level: 'error' } } });
		await op({ operation: 'create_database', database: DATABASE });
		await seed('Dynamic');
		await seed('WithDeleted', ['code-7']);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('successive drops keep every row and its remaining fields', async () => {
		await dropThenRestoreCatalogAttribute('Dynamic', 'price');
		await assertRows('Dynamic', ['code', 'name', 'qty'], ids);
		await dropThenRestoreCatalogAttribute('Dynamic', 'qty');
		await assertRows('Dynamic', ['code', 'name'], ids);
		await dropThenRestoreCatalogAttribute('Dynamic', 'name');
		await assertRows('Dynamic', ['code'], ids);
	});

	test('a drop leaves a deleted row deleted', async () => {
		await dropThenRestoreCatalogAttribute('WithDeleted', 'price');
		await assertRows(
			'WithDeleted',
			['code', 'name', 'qty'],
			ids.filter((id) => id !== 'code-7')
		);
	});
});
