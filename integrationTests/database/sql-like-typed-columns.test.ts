/** Tests lexical LIKE selection and mutation on typed and dynamic columns through the Operations API. */
import { suite, test, before, beforeEach, after } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE = resolve(import.meta.dirname, 'sql-like-typed-columns');
const SEED = [0, 5, 50, 105, 150, -5, null, undefined].map((intCol, i) => ({
	id: i + 1,
	...(intCol === undefined ? {} : { intCol }),
	code: intCol == null ? '' : String(intCol),
	tags: i === 3 ? ['news', 'sports'] : i === 4 ? ['sports'] : [],
	flag: 'seed',
}));
const CASES: [string, number[]][] = [
	['05%', []],
	['%5', [2, 4, 6]],
	['%0%', [1, 3, 4, 5]],
	['', []],
	['0105', []],
	['1%', [4, 5]],
	['%05%', [4]],
	['%', [1, 2, 3, 4, 5, 6]],
];
const ids = (rows: { id: number }[]) => rows.map((row) => row.id).sort((a, b) => a - b);

for (const engine of ['auto', 'new', 'legacy']) {
	suite(
		`typed LIKE [sql=${engine}, storage=${process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb'}]`,
		(ctx: ContextWithHarper) => {
			let client: ReturnType<typeof createApiClient>;
			const operation = async (body: object) => {
				const response = await client.req().send(body).timeout(60_000);
				strictEqual(response.status, 200, JSON.stringify(response.body));
				return response.body;
			};
			const sql = (statement: string) => operation({ operation: 'sql', sql: statement });
			const read = () =>
				operation({
					operation: 'search_by_value',
					schema: 'data',
					table: 'Item',
					search_attribute: 'id',
					search_value: '*',
					get_attributes: ['id', 'flag'],
				});
			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE, {
					config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
					env: { HARPER_SQL_ENGINE: engine },
				});
				client = createApiClient(ctx.harper);
				await restartHttpWorkers(client, '/Item/', 120_000);
				await operation({ operation: 'create_table', schema: 'data', table: 'Dynamic', hash_attribute: 'id' });
				await operation({
					operation: 'upsert',
					schema: 'data',
					table: 'Dynamic',
					records: [
						{ id: 1, mixed: 105, marker: 'seed' },
						{ id: 2, mixed: '105', marker: 'seed' },
						{ id: 3, mixed: '05', marker: 'seed' },
						{ id: 4, mixed: 'Penny', marker: 'seed' },
						{ id: 5, mixed: 'penelope', marker: 'seed' },
					],
				});
			});
			beforeEach(async () => {
				await operation({ operation: 'upsert', schema: 'data', table: 'Item', records: SEED });
			});
			after(async () => {
				await teardownHarper(ctx);
			});

			for (const [pattern, expected] of CASES) {
				for (const [verb, guard] of [
					['SELECT', 'id >= 0 AND '],
					['UPDATE', 'id >= 0 AND '],
					['DELETE', 'id >= 0 AND '],
					// Standalone: legacy fallback under auto must not match null or omitted values either.
					...(engine === 'new'
						? []
						: [
								['SELECT', ''],
								['UPDATE', ''],
								['DELETE', ''],
							]),
				]) {
					test(`${verb} ${guard}intCol LIKE '${pattern}'`, async () => {
						const where = `${guard}intCol LIKE '${pattern}'`;
						const statement =
							verb === 'SELECT'
								? `SELECT id FROM data.Item WHERE ${where}`
								: verb === 'UPDATE'
									? `UPDATE data.Item SET flag = 'hit' WHERE ${where}`
									: `DELETE FROM data.Item WHERE ${where}`;
						const result = await sql(statement);
						const actual =
							verb === 'SELECT'
								? ids(result)
								: [...result[verb === 'UPDATE' ? 'update_hashes' : 'deleted_hashes']].sort((a, b) => a - b);
						deepStrictEqual(actual, expected);
						const rows = await read();
						deepStrictEqual(
							ids(rows.filter((row: { flag: string }) => row.flag === 'hit')),
							verb === 'UPDATE' ? expected : []
						);
						deepStrictEqual(
							ids(rows),
							SEED.map((row) => row.id).filter((id) => verb !== 'DELETE' || !expected.includes(id))
						);
					});
				}
			}
			test('a declared String prefix can drive the scan on its own', async () => {
				deepStrictEqual(ids(await sql("SELECT id FROM data.Item WHERE code LIKE '1%'")), [4, 5]);
			});
			test('list LIKE matches joined text for selection and mutations', async () => {
				deepStrictEqual(ids(await sql("SELECT id FROM data.Item WHERE id >= 0 AND tags LIKE 'sports%'")), [5]);
				deepStrictEqual(ids(await sql("SELECT id FROM data.Item WHERE id >= 0 AND tags LIKE '%s,sp%'")), [4]);
				deepStrictEqual(ids(await sql("SELECT id FROM data.Item WHERE id >= 0 AND tags LIKE 'news,sports'")), [4]);
				deepStrictEqual(
					(await sql("UPDATE data.Item SET flag = 'hit' WHERE id >= 0 AND tags LIKE 'news,sports'")).update_hashes,
					[4]
				);
				deepStrictEqual(ids((await read()).filter((row: { flag: string }) => row.flag === 'hit')), [4]);
				deepStrictEqual((await sql("DELETE FROM data.Item WHERE id >= 0 AND tags LIKE 'sports%'")).deleted_hashes, [5]);
				deepStrictEqual(ids(await read()), [1, 2, 3, 4, 6, 7, 8]);
			});
			test('dynamic mixed values use lexical matching', async () => {
				deepStrictEqual(ids(await sql("SELECT id FROM data.Dynamic WHERE id >= 0 AND mixed LIKE '1%'")), [1, 2]);
				if (engine !== 'new')
					deepStrictEqual(ids(await sql("SELECT id FROM data.Dynamic WHERE mixed LIKE '1%'")), [1, 2]);
			});
			test('dynamic standalone LIKE follows legacy case folding under auto, including mutations', async () => {
				const where = "mixed LIKE 'Pen%'";
				const guarded = await sql(`SELECT id FROM data.Dynamic WHERE id >= 0 AND ${where}`);
				deepStrictEqual(ids(guarded), engine === 'legacy' ? [4, 5] : [4]);
				const statements = [
					`SELECT id FROM data.Dynamic WHERE ${where}`,
					`UPDATE data.Dynamic SET marker = 'hit' WHERE ${where}`,
					`DELETE FROM data.Dynamic WHERE ${where}`,
				];
				if (engine === 'new') {
					for (const statement of statements) {
						const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(60_000);
						strictEqual(response.status, 400, JSON.stringify(response.body));
					}
					deepStrictEqual(ids(await sql('SELECT id FROM data.Dynamic WHERE id >= 0')), [1, 2, 3, 4, 5]);
					deepStrictEqual(ids(await sql("SELECT id FROM data.Dynamic WHERE id >= 0 AND marker = 'hit'")), []);
					return;
				}
				deepStrictEqual(ids(await sql(statements[0])), [4, 5]);
				deepStrictEqual(
					(await sql(statements[1])).update_hashes.sort((a: number, b: number) => a - b),
					[4, 5]
				);
				deepStrictEqual(ids(await sql("SELECT id FROM data.Dynamic WHERE id >= 0 AND marker = 'hit'")), [4, 5]);
				deepStrictEqual(
					(await sql(statements[2])).deleted_hashes.sort((a: number, b: number) => a - b),
					[4, 5]
				);
				deepStrictEqual(ids(await sql('SELECT id FROM data.Dynamic WHERE id >= 0')), [1, 2, 3]);
			});
			if (engine === 'new')
				test('standalone non-String LIKE needs an index driver', async () => {
					for (const statement of [
						"SELECT id FROM data.Item WHERE intCol LIKE '1%'",
						"UPDATE data.Item SET flag = 'hit' WHERE intCol LIKE '0105'",
						"DELETE FROM data.Item WHERE intCol LIKE ''",
						"SELECT id FROM data.Dynamic WHERE mixed LIKE '1%'",
					]) {
						const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(60_000);
						strictEqual(response.status, 400, JSON.stringify(response.body));
						strictEqual(response.body.error.includes('no usable index condition'), true, response.body.error);
					}
					deepStrictEqual(
						ids(await read()),
						SEED.map((row) => row.id)
					);
					deepStrictEqual(
						(await read()).map((row: { flag: string }) => row.flag),
						SEED.map(() => 'seed')
					);
				});
		}
	);
}
