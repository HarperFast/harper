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

// 20 rows of about 100,000 characters (QA SQA-133 arm B), with a line feed every 10,000 characters in even
// rows and every 9,999 in odd ones. When `_` matched no line terminator, a search retrying every start position
// took 3.6 s (v2) and 10 s (legacy) per statement.
const LINES = Array.from({ length: 20 }, (_, i) => ({
	id: 'line' + i,
	tag: 'line',
	note: ('a'.repeat(i % 2 ? 9_998 : 9_999) + '\n').repeat(10),
	flag: 'none',
}));
const AT_LIMIT = `'%${'_'.repeat(10_000)}%'`;
// Two line feeds 9,999 apart: the odd rows.
const LINE_PAIR = `'%\n${'_'.repeat(9_998)}\n%'`;
const LINE_STATEMENT_MS = 1_000;

// Six classes split the 34 noncharacters by index bit, so legacy draws `_`'s placeholder from the Private Use
// Area (U+F8FF, then U+F8FE). Compiling each `_` as `[^]` instead, 16 wide segments took ~5 s (QA SF-86).
const NONCHARACTERS = ['\uffff', '\ufffe'];
for (let code = 0xfdd0; code <= 0xfdef; code++) NONCHARACTERS.push(String.fromCharCode(code));
const SPLITTING = Array.from(
	{ length: 6 },
	(_, bit) => `[a${NONCHARACTERS.filter((_, i) => (i >> bit) & 1).join('')}]`
).join('');
const TAILS = Array.from({ length: 16 }, (_, k) => String.fromCharCode(98 + k) + 'b');
const SPLIT_WIDE = `'%${SPLITTING}%${TAILS.map((tail) => '_'.repeat(9_998) + tail + '%').join('')}'`;
const SPLIT_RUN = `'%${SPLITTING}%a${'_'.repeat(65)}b%'`;
const WIDE_MATCH = 'a'.repeat(6) + TAILS.map((tail) => 'x'.repeat(9_998) + tail).join('');
const WIDE = [
	{ id: 'wide', note: WIDE_MATCH },
	{ id: 'wideMiss', note: WIDE_MATCH.slice(0, -2) + 'zz' },
	{ id: 'placeholder', note: 'a'.repeat(7) + '\uf8ff'.repeat(65) + 'b' },
	{ id: 'substitute', note: 'a'.repeat(7) + '\uf8fe'.repeat(65) + 'b' },
	{ id: 'mixed', note: 'A'.repeat(7) + '\uf8ff\uf8fe\ue000'.repeat(22).slice(0, 65) + 'B' },
	{ id: 'short', note: 'a'.repeat(7) + '\uf8ff'.repeat(64) + 'b' },
	{ id: 'other', note: 'a'.repeat(7) + '\uf8ff'.repeat(65) + 'c' },
].map((row) => ({ ...row, flag: 'none' }));
const WIDE_IDS = WIDE.map((row) => row.id).sort();
const SPLIT_RUN_IDS = ['mixed', 'placeholder', 'substitute'];
// One unit of every consecutive pair in every placeholder run, so no placeholder is left.
const EVERY_PAIR: string[] = [];
for (const [low, high] of [
	[0xfffe, 0xffff],
	[0xfdd0, 0xfdef],
	[0xe000, 0xf8ff],
]) {
	for (let code = high - 1; code >= low; code -= 2) EVERY_PAIR.push(String.fromCharCode(code));
}
const NO_PLACEHOLDER = `'a${'_'.repeat(65)}[${EVERY_PAIR.join('')}]'`;
const SPLIT_STATEMENT_MS = 2_000;

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

			if (sqlEngine !== 'new') {
				// Without an index driver, `auto` evaluates the LIKE in alasql; v2 reads `[` literally.
				const reseedWide = async () => {
					await client
						.req()
						.send({ operation: 'upsert', schema: SCHEMA, table: 'Wide', records: WIDE })
						.timeout(60_000)
						.expect(200);
				};

				test('a pattern whose classes split the noncharacters compiles 16 wide segments promptly', async () => {
					await reseedWide();
					const start = performance.now();
					const body = await sql(client, `SELECT id FROM ${SCHEMA}.Wide WHERE note LIKE ${SPLIT_WIDE}`, 30_000);
					const ms = performance.now() - start;
					deepStrictEqual(sortedIds(body), ['wide']);
					strictEqual(ms < SPLIT_STATEMENT_MS, true, `took ${ms.toFixed(0)} ms`);
				});

				for (const [verb, statement, check] of [
					['SELECT', `SELECT id FROM ${SCHEMA}.Wide WHERE note LIKE ${SPLIT_RUN}`, (body: any) => sortedIds(body)],
					[
						'UPDATE',
						`UPDATE ${SCHEMA}.Wide SET flag = 'hit' WHERE note LIKE ${SPLIT_RUN}`,
						(body: any) => [...body.update_hashes].sort(),
					],
					[
						'DELETE',
						`DELETE FROM ${SCHEMA}.Wide WHERE note LIKE ${SPLIT_RUN}`,
						(body: any) => [...body.deleted_hashes].sort(),
					],
				] as const) {
					test(`${verb} matches values holding the private-use placeholder and its substitute under _`, async () => {
						await reseedWide();
						deepStrictEqual(check(await sql(client, statement)), SPLIT_RUN_IDS);
						const rows = await readTable(client, 'Wide');
						deepStrictEqual(
							sortedIds(rows.filter((row) => row.flag === 'hit')),
							verb === 'UPDATE' ? SPLIT_RUN_IDS : []
						);
						deepStrictEqual(
							sortedIds(rows),
							verb === 'DELETE' ? WIDE_IDS.filter((id) => !SPLIT_RUN_IDS.includes(id)) : WIDE_IDS
						);
					});
				}

				for (const statement of [
					`SELECT id FROM ${SCHEMA}.Wide WHERE note LIKE ${NO_PLACEHOLDER}`,
					`DELETE FROM ${SCHEMA}.Wide WHERE note LIKE ${NO_PLACEHOLDER}`,
				]) {
					test(`${statement.split(' ')[0]} naming a unit of every placeholder pair past 64 _ is a 400`, async () => {
						await reseedWide();
						const response = await client.req().send({ operation: 'sql', sql: statement }).timeout(15_000);
						strictEqual(response.status, 400, JSON.stringify(response.body));
						deepStrictEqual(sortedIds(await readTable(client, 'Wide')), WIDE_IDS);
						deepStrictEqual(
							sortedIds(await sql(client, `SELECT id FROM ${SCHEMA}.Wide WHERE note LIKE ${SPLIT_RUN}`)),
							SPLIT_RUN_IDS
						);
					});
				}
			}

			const lineIds = LINES.map((row) => row.id).sort();
			const oddIds = LINES.filter((_, i) => i % 2)
				.map((row) => row.id)
				.sort();
			const lineCases: { statement: string; check: (body: any) => void; hit?: string[]; deleted?: string[] }[] = [
				{
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE ${AT_LIMIT}`,
					check: (body) => deepStrictEqual(sortedIds(body), lineIds),
				},
				{
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note NOT LIKE ${AT_LIMIT}`,
					check: (body) => deepStrictEqual(body, []),
				},
				{
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE ${LINE_PAIR}`,
					check: (body) => deepStrictEqual(sortedIds(body), oddIds),
				},
				{
					statement: `UPDATE ${SCHEMA}.Lines SET flag = 'hit' WHERE tag = 'line' AND note LIKE ${LINE_PAIR}`,
					check: (body) => deepStrictEqual([...body.update_hashes].sort(), oddIds),
					hit: oddIds,
				},
				{
					statement: `DELETE FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE ${LINE_PAIR}`,
					check: (body) => deepStrictEqual([...body.deleted_hashes].sort(), oddIds),
					deleted: oddIds,
				},
				{
					// Bun's RegExp engine retries a run of `_` before a literal at every start (value × run), so the
					// runs stay short here; v2 and legacy take ~1.2 s per statement at 5,000 on Bun, ~40 ms on Node.
					statement: `DELETE FROM ${SCHEMA}.Lines WHERE tag = 'line' AND note LIKE '%${'_'.repeat(500)}!_${'_'.repeat(499)}%' ESCAPE '!'`,
					check: (body) => deepStrictEqual(body.deleted_hashes, []),
				},
			];
			// Without an index driver, `auto` evaluates the LIKE in alasql.
			if (sqlEngine !== 'new') {
				lineCases.push({
					statement: `SELECT id FROM ${SCHEMA}.Lines WHERE note LIKE ${LINE_PAIR}`,
					check: (body) => deepStrictEqual(sortedIds(body), oddIds),
				});
			}
			for (const { statement, check, hit = [], deleted = [] } of lineCases) {
				const shown = statement.replace(/(.)\1{20,}/g, (run, char) => `${char}×${run.length}`).replaceAll('\n', '\\n');
				test(`${shown} matches line feeds under _ promptly`, async () => {
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
					deepStrictEqual(sortedIds(rows.filter((row) => row.flag === 'hit')), hit);
					deepStrictEqual(
						sortedIds(rows),
						lineIds.filter((id) => !deleted.includes(id))
					);
					strictEqual(ms < LINE_STATEMENT_MS, true, `took ${ms.toFixed(0)} ms`);
				});
			}
		}
	);
}
