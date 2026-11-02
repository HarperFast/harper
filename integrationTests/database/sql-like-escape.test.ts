/**
 * `LIKE … ESCAPE` row sets on an indexed column (#3878), and regex-backtracking LIKE patterns returning promptly
 * (#1930), under `auto`, `new` and `legacy`.
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sql-like-escape');
const SCHEMA = 'data';
const TABLE = 'Addr';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

const IPS = ['t_0', 'tx0', 't!x0', 't!_0', 't0%', 't0!z', 't0a'];
// The long value lives in the unindexed column: index keys have a size limit.
const LONG = { id: 'long', ip: 'tlong', note: 'a'.repeat(10_000), flag: 'none' };
const SEED = [...IPS.map((ip) => ({ id: ip, ip, note: ip, flag: 'none' })), LONG];
const ALL_IDS = SEED.map((row) => row.id).sort();

const ESCAPE_CASES: { where: string; expected: string[] }[] = [
	{ where: `ip LIKE 't0!%' ESCAPE '!'`, expected: ['t0%'] },
	{ where: `ip LIKE 't!_0' ESCAPE '!'`, expected: ['t_0'] },
	{ where: `ip LIKE 't!!%' ESCAPE '!'`, expected: ['t!_0', 't!x0'] },
	{ where: `ip LIKE 't0!%%' ESCAPE '!'`, expected: ['t0%'] },
	// controls without ESCAPE
	{ where: `ip LIKE 't0%'`, expected: ['t0!z', 't0%', 't0a'] },
	{ where: `ip LIKE 't0!%'`, expected: ['t0!z'] },
];

const REDOS_PATTERNS = ['%_%_%_%_%_%_%_%_%_%_%_%_%_%_Z', '%a%a%a%a%a%a%a%a%a%a%a%a%a%aZ'];

type Client = ReturnType<typeof createApiClient>;

async function sql(client: Client, statement: string, timeout = 60_000): Promise<any> {
	const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(timeout);
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

async function reseed(client: Client): Promise<void> {
	await client
		.req()
		.send({ operation: 'upsert', schema: SCHEMA, table: TABLE, records: SEED })
		.timeout(60_000)
		.expect(200);
	deepStrictEqual(sortedIds(await readTable(client)), ALL_IDS);
}

function sortedIds(rows: { id: string }[]): string[] {
	return rows.map((row) => row.id).sort();
}

for (const sqlEngine of ['auto', 'new', 'legacy']) {
	suite(
		`SQL LIKE ESCAPE and linear matching [storage=${ENGINE}, sql.engine=${sqlEngine}]`,
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

			for (const { where, expected } of ESCAPE_CASES) {
				test(`SELECT WHERE ${where}`, async () => {
					deepStrictEqual(sortedIds(await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}`)), expected);
				});

				test(`DELETE WHERE ${where}`, async () => {
					await reseed(client);
					const result = await sql(client, `DELETE FROM ${SCHEMA}.${TABLE} WHERE ${where}`);
					deepStrictEqual([...result.deleted_hashes].sort(), expected);
					deepStrictEqual(
						sortedIds(await readTable(client)),
						ALL_IDS.filter((id) => !expected.includes(id))
					);
				});

				test(`UPDATE WHERE ${where}`, async () => {
					await reseed(client);
					const result = await sql(client, `UPDATE ${SCHEMA}.${TABLE} SET flag = 'hit' WHERE ${where}`);
					deepStrictEqual([...result.update_hashes].sort(), expected);
					deepStrictEqual(sortedIds((await readTable(client)).filter((row) => row.flag === 'hit')), expected);
				});
			}

			for (const pattern of REDOS_PATTERNS) {
				// Without an index driver, `auto` evaluates the LIKE in alasql.
				const wheres = [`ip LIKE 't%' AND note LIKE '${pattern}'`];
				if (sqlEngine !== 'new') wheres.push(`note LIKE '${pattern}'`);
				for (const where of wheres) {
					test(`SELECT WHERE ${where} returns promptly`, async () => {
						await reseed(client);
						deepStrictEqual(await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}`, 15_000), []);
					});
				}
			}
		}
	);
}
