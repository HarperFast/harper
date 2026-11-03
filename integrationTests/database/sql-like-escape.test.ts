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
	{ where: `ip LIKE 't0%'`, expected: ['t0!z', 't0%', 't0a'] },
	{ where: `ip LIKE 't0!%'`, expected: ['t0!z'] },
];

const REDOS_PATTERNS = ['%_%_%_%_%_%_%_%_%_%_%_%_%_%_Z', '%a%a%a%a%a%a%a%a%a%a%a%a%a%aZ'];

// 20 rows of 100,000 characters with a line feed every 10,000 (QA SQA-133 arm B). `_` matches no line
// terminator, so no 10,000-wide window matches; a search retrying every start position took 3.6 s (v2) and
// 10 s (legacy) per statement.
const LINES = Array.from({ length: 20 }, (_, i) => ({
	id: 'line' + i,
	tag: 'line',
	note: ('a'.repeat(9_999) + '\n').repeat(10),
	flag: 'none',
}));
const AT_LIMIT = `'%${'_'.repeat(10_000)}%'`;
const LINE_STATEMENT_MS = 1_000;

type Client = ReturnType<typeof createApiClient>;

async function sql(client: Client, statement: string, timeout = 60_000): Promise<any> {
	const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(timeout);
	strictEqual(response.status, 200, `${statement} -> ${response.status} ${JSON.stringify(response.body)}`);
	return response.body;
}

async function readTable(client: Client, table = TABLE): Promise<{ id: string; flag: string }[]> {
	const response = await client
		.req()
		.send({
			operation: 'search_by_value',
			schema: SCHEMA,
			table,
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

			for (const where of [
				`note LIKE 't0!' ESCAPE '!'`,
				`note LIKE 't0!%' ESCAPE '!!'`,
				`note LIKE 't0%' ESCAPE ''`,
				`note LIKE '[z-a]%'`,
				`note LIKE '%${'_'.repeat(10_001)}c%'`,
				`ip LIKE 't%' AND note LIKE '%${'a'.repeat(10_000)}_b%'`,
			]) {
				if (where.includes('[') && sqlEngine === 'new') continue;
				for (const statement of [
					`SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}`,
					`DELETE FROM ${SCHEMA}.${TABLE} WHERE ${where}`,
				]) {
					const shown = statement.replace(/(.)\1{20,}/g, (run, char) => `${char}×${run.length}`);
					test(`${shown} is a 400`, async () => {
						await reseed(client);
						const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(15_000);
						strictEqual(response.status, 400, JSON.stringify(response.body));
						deepStrictEqual(sortedIds(await readTable(client)), ALL_IDS);
					});
				}
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

			test('a numeric pattern matches no row, on every engine', async () => {
				await reseed(client);
				await client
					.req()
					.send({ operation: 'upsert', schema: SCHEMA, table: TABLE, records: [{ id: 'n', ip: 'tn', note: '123' }] })
					.timeout(60_000)
					.expect(200);
				deepStrictEqual(
					await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ip LIKE 't%' AND note LIKE 123`),
					[]
				);
				await client
					.req()
					.send({ operation: 'delete', schema: SCHEMA, table: TABLE, hash_values: ['n'] })
					.timeout(60_000)
					.expect(200);
			});

			const lineIds = LINES.map((row) => row.id).sort();
			const lineCases: { statement: string; check: (body: any) => void }[] = [
				{
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE ${AT_LIMIT}`,
					check: (body) => deepStrictEqual(body, []),
				},
				{
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note NOT LIKE ${AT_LIMIT}`,
					check: (body) => deepStrictEqual(sortedIds(body), lineIds),
				},
				{
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE '%${'_'.repeat(9_999)}%'`,
					check: (body) => deepStrictEqual(sortedIds(body), lineIds),
				},
				{
					statement: `UPDATE ${SCHEMA}.Lines SET flag = 'hit' WHERE tag = 'line' AND note LIKE ${AT_LIMIT}`,
					check: (body) => deepStrictEqual(body.update_hashes, []),
				},
				{
					statement: `DELETE FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE '%${'_'.repeat(5_000)}!_${'_'.repeat(4_999)}%' ESCAPE '!'`,
					check: (body) => deepStrictEqual(body.deleted_hashes, []),
				},
			];
			// Without an index driver, `auto` evaluates the LIKE in alasql.
			if (sqlEngine !== 'new') {
				lineCases.push({
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE note LIKE ${AT_LIMIT}`,
					check: (body) => deepStrictEqual(body, []),
				});
			}
			for (const { statement, check } of lineCases) {
				const shown = statement.replace(/(.)\1{20,}/g, (run, char) => `${char}×${run.length}`);
				test(`${shown} skips past line terminators`, async () => {
					await client
						.req()
						.send({ operation: 'upsert', schema: SCHEMA, table: 'Lines', records: LINES })
						.timeout(60_000)
						.expect(200);
					const start = performance.now();
					const body = await sql(client, statement, 30_000);
					const ms = performance.now() - start;
					check(body);
					const rows = await readTable(client, 'Lines');
					deepStrictEqual(sortedIds(rows.filter((row) => row.flag === 'none')), lineIds);
					strictEqual(ms < LINE_STATEMENT_MS, true, `took ${ms.toFixed(0)} ms`);
				});
			}
		}
	);
}
