/**
 * harper#3212: SELECT, UPDATE and DELETE row sets over values, explicit NULLs and omitted attributes must not depend on
 * which conjunct leads the index scan. `a` and `b` are seeded symmetrically, so a commuted pair such as
 * `a <= 1 AND b <= 1` / `b <= 1 AND a <= 1` ties on estimate and each order leads once.
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sql-null-omitted-conjunctions');
const SCHEMA = 'data';
const TABLE = 'Item';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

const SEED: Record<string, any>[] = [
	{ id: 'r1', c: 'alpha', a: 1, b: 1 },
	{ id: 'r_a1_b5', c: 'alpha', a: 1, b: 5 },
	{ id: 'r_a1_bnull', c: 'alpha', a: 1, b: null },
	{ id: 'r_a1_babsent', c: 'alpha', a: 1 },
	{ id: 'r_a5_b1', c: 'beta', a: 5, b: 1 },
	{ id: 'r_anull_b1', c: 'beta', a: null, b: 1 },
	{ id: 'r_aabsent_b1', c: 'beta', b: 1 },
	{ id: 'r_a5_b5', c: 'gamma', a: 5, b: 5 },
].map((row) => ({ ...row, flag: 'none' }));
const ALL_IDS = SEED.map((row) => row.id).sort();
const ALPHA_IDS = ['r1', 'r_a1_b5', 'r_a1_babsent', 'r_a1_bnull'];

const CASES: { wheres: string[]; expected: string[] }[] = [
	{ wheres: [`c = 'alpha' AND b <= 1`, `b <= 1 AND c = 'alpha'`], expected: ['r1'] },
	{ wheres: [`c = 'alpha' AND b < 3`, `b < 3 AND c = 'alpha'`], expected: ['r1'] },
	{ wheres: [`c = 'alpha' AND NOT (b > 1)`, `NOT (b > 1) AND c = 'alpha'`], expected: ['r1'] },
	{ wheres: [`a <= 1 AND b <= 1`, `b <= 1 AND a <= 1`], expected: ['r1'] },
	{ wheres: [`NOT (a > 1 OR b > 1)`, `NOT (b > 1 OR a > 1)`], expected: ['r1'] },
	{ wheres: [`c = 'alpha' AND b != 5`, `b != 5 AND c = 'alpha'`], expected: ['r1'] },
	{ wheres: [`c = 'alpha' AND b NOT IN (5, 7)`, `c = 'alpha' AND NOT (b IN (5, 7))`], expected: ['r1'] },
	{ wheres: [`c = 'alpha' AND b IS NOT NULL`, `c = 'alpha' AND NOT (b IS NULL)`], expected: ['r1', 'r_a1_b5'] },
	{ wheres: [`c = 'alpha' AND b IS NULL`, `b IS NULL AND c = 'alpha'`], expected: ['r_a1_babsent', 'r_a1_bnull'] },
	{ wheres: [`c = 'alpha' AND (b IS NULL OR b = 5)`], expected: ['r_a1_b5', 'r_a1_babsent', 'r_a1_bnull'] },
	{ wheres: [`c = 'alpha' AND (b IS NULL OR b IS NOT NULL)`], expected: ALPHA_IDS },
];

type Client = ReturnType<typeof createApiClient>;

async function sql(client: Client, statement: string): Promise<any> {
	const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(60_000);
	strictEqual(response.status, 200, `${statement} -> ${response.status} ${JSON.stringify(response.body)}`);
	return response.body;
}

async function readTable(client: Client): Promise<{ id: string; flag: string }[]> {
	const response = await client
		.req()
		.send({
			operation: 'search_by_value',
			schema: SCHEMA,
			table: TABLE,
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'flag'],
		})
		.timeout(60_000)
		.expect(200);
	return response.body;
}

function sortedIds(rows: { id: string }[]): string[] {
	return rows.map((row) => row.id).sort();
}

async function reseed(client: Client): Promise<void> {
	await client
		.req()
		.send({ operation: 'delete', schema: SCHEMA, table: TABLE, hash_values: ALL_IDS })
		.timeout(60_000)
		.expect(200);
	await client
		.req()
		.send({ operation: 'insert', schema: SCHEMA, table: TABLE, records: SEED })
		.timeout(60_000)
		.expect(200);
	deepStrictEqual(sortedIds(await readTable(client)), ALL_IDS);
}

// Under `new`, an EngineUnsupportedError fails the request instead of falling back to legacy, so these row sets are
// sqlEngine v2's own.
for (const sqlEngine of ['auto', 'new']) {
	suite(
		`SQL conjunctions over NULL and omitted attributes [storage=${ENGINE}, sql.engine=${sqlEngine}]`,
		{ skip: process.platform === 'win32' },
		(ctx: ContextWithHarper) => {
			let client: Client;

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
					env: { HARPER_SQL_ENGINE: sqlEngine },
				});
				client = createApiClient(ctx.harper);
				await restartHttpWorkers(client, `/${TABLE}/`, 120_000);
				await reseed(client);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			for (const { wheres, expected } of CASES) {
				for (const where of wheres) {
					test(`SELECT WHERE ${where}`, async () => {
						await reseed(client);
						const rows = await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}`);
						deepStrictEqual(sortedIds(rows), expected);
					});

					test(`UPDATE WHERE ${where} touches only the selected rows`, async () => {
						await reseed(client);
						const result = await sql(client, `UPDATE ${SCHEMA}.${TABLE} SET flag = 'hit' WHERE ${where}`);
						deepStrictEqual([...result.update_hashes].sort(), expected);
						deepStrictEqual(sortedIds((await readTable(client)).filter((row) => row.flag === 'hit')), expected);
					});

					test(`DELETE WHERE ${where} removes only the selected rows`, async () => {
						await reseed(client);
						const result = await sql(client, `DELETE FROM ${SCHEMA}.${TABLE} WHERE ${where}`);
						deepStrictEqual([...result.deleted_hashes].sort(), expected);
						deepStrictEqual(
							sortedIds(await readTable(client)),
							ALL_IDS.filter((id) => !expected.includes(id))
						);
					});
				}
			}

			// IS NULL is filter-only, so alone it has no index to drive the scan: `auto` answers it on legacy, `new` rejects it.
			test('SELECT WHERE b IS NULL with no other condition', async () => {
				await reseed(client);
				const response = await client
					.req()
					.send({ operation: 'sql', sql: `SELECT id FROM ${SCHEMA}.${TABLE} WHERE b IS NULL` })
					.timeout(60_000);
				if (sqlEngine === 'new') {
					strictEqual(response.status, 400);
					strictEqual(response.body.error.includes('has no usable index condition'), true, response.body.error);
				} else {
					strictEqual(response.status, 200);
					deepStrictEqual(sortedIds(response.body), ['r_a1_babsent', 'r_a1_bnull']);
				}
			});

			for (const [query, expected] of [
				['c=alpha&b=lt=3', ['r1']],
				['b=lt=3&c=alpha', ['r1']],
				['c=alpha&b=le=1', ['r1']],
				['c=alpha&b=ne=null', ['r1', 'r_a1_b5']],
			] as const) {
				test(`REST GET /${TABLE}/?${query}`, async () => {
					await reseed(client);
					const response = await client.reqRest(`/${TABLE}/?${query}`).timeout(60_000);
					strictEqual(response.status, 200, `${query} -> ${response.status}`);
					deepStrictEqual(sortedIds(response.body), expected);
				});
			}
		}
	);
}
