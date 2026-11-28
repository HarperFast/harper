/**
 * Legacy SQL row selection through the `sql` operation (#4552): a WHERE nested more than 100 levels deep, and
 * `IS NOT NULL` in UPDATE and DELETE, select the rows the predicate matches, under `legacy` and under `auto`
 * (whose fallback runs the legacy engine).
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sql-legacy-row-selection');
const TABLE = 'data.Thing';
const ROWS = 160;
// ids 1-9 carry the null and falsy values; the rest hold their id
const NULLISH: Record<number, unknown> = { 1: null, 2: 0, 3: false, 4: '', 5: 1, 6: true, 7: undefined, 8: 'x', 9: 2 };
const SEED = Array.from({ length: ROWS }, (_, i) => {
	const id = i + 1;
	const record: Record<string, unknown> = { id, grp: id in NULLISH ? 'nullish' : 'plain', flag: 'none' };
	const v = id in NULLISH ? NULLISH[id] : id;
	if (v !== undefined) record.v = v;
	return record;
});
const ALL_IDS = SEED.map((record) => record.id as number);
const NOT_NULL = [2, 3, 4, 5, 6, 8, 9];
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const CASES: { name: string; where: string; expected: number[] }[] = [
	{ name: 'IS NOT NULL', where: `grp = 'nullish' AND v IS NOT NULL`, expected: NOT_NULL },
	{ name: 'NOT IS NULL', where: `grp = 'nullish' AND NOT v IS NULL`, expected: NOT_NULL },
	{ name: 'NOT (IS NOT NULL)', where: `grp = 'nullish' AND NOT (v IS NOT NULL)`, expected: [1, 7] },
	{
		name: 'IS NOT NULL beside a CASE',
		where: `grp = 'nullish' AND v IS NOT NULL AND (CASE WHEN id > 0 THEN 1 ELSE 0 END) = 1`,
		expected: NOT_NULL,
	},
	{
		name: 'OR of 150 keys',
		where: range(1, 150)
			.map((id) => `id = ${id}`)
			.join(' OR '),
		expected: range(1, 150),
	},
	{
		name: 'NOT of that OR',
		where: `NOT (${range(1, 150)
			.map((id) => `id = ${id}`)
			.join(' OR ')})`,
		expected: range(151, ROWS),
	},
	{
		name: 'AND of 120 inequalities',
		where: range(1001, 1120)
			.map((id) => `id <> ${id}`)
			.join(' AND '),
		expected: ALL_IDS,
	},
	{ name: '120 parentheses', where: `${'('.repeat(120)}id > 150${')'.repeat(120)}`, expected: range(151, ROWS) },
	{ name: '240 NOTs', where: `${'NOT '.repeat(240)}id > 150`, expected: range(151, ROWS) },
];

type Client = ReturnType<typeof createApiClient>;

async function sql(client: Client, statement: string): Promise<any> {
	const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(60_000);
	strictEqual(
		response.status,
		200,
		`${statement.slice(0, 120)} -> ${response.status} ${JSON.stringify(response.body)}`
	);
	return response.body;
}

async function readTable(client: Client): Promise<{ id: number; flag: string }[]> {
	const response = await client
		.req()
		.send({
			operation: 'search_by_value',
			database: 'data',
			table: 'Thing',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id', 'flag'],
		})
		.timeout(60_000)
		.expect(200);
	return response.body;
}

async function reseed(client: Client): Promise<void> {
	await client
		.req()
		.send({ operation: 'upsert', database: 'data', table: 'Thing', records: SEED })
		.timeout(60_000)
		.expect(200);
	deepStrictEqual(sorted((await readTable(client)).map((row) => row.id)), ALL_IDS);
}

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

for (const sqlEngine of ['legacy', 'auto']) {
	suite(
		`legacy SQL row selection [sql.engine=${sqlEngine}]`,
		{ skip: process.platform === 'win32' },
		(ctx: ContextWithHarper) => {
			let client: Client;

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
					env: { HARPER_SQL_ENGINE: sqlEngine },
				});
				client = createApiClient(ctx.harper);
				await restartHttpWorkers(client, '/Thing/', 120_000);
				await reseed(client);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			for (const { name, where, expected } of CASES) {
				test(`${name}: SELECT, UPDATE and DELETE pick the matching rows`, async () => {
					await reseed(client);
					const rows = await sql(client, `SELECT id FROM ${TABLE} WHERE ${where}`);
					deepStrictEqual(sorted(rows.map((row: { id: number }) => row.id)), expected, 'SELECT');

					const update = await sql(client, `UPDATE ${TABLE} SET flag = 'hit' WHERE ${where}`);
					deepStrictEqual(sorted(update.update_hashes), expected, 'UPDATE reported');
					const hit = (await readTable(client)).filter((row) => row.flag === 'hit').map((row) => row.id);
					deepStrictEqual(sorted(hit), expected, 'UPDATE stored');

					await reseed(client);
					const removal = await sql(client, `DELETE FROM ${TABLE} WHERE ${where}`);
					deepStrictEqual(sorted(removal.deleted_hashes), expected, 'DELETE reported');
					const survivors = new Set((await readTable(client)).map((row) => row.id));
					deepStrictEqual(
						ALL_IDS.filter((id) => !survivors.has(id)),
						expected,
						'DELETE stored'
					);
				});
			}
		}
	);
}
