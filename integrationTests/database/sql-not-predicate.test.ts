/**
 * WHERE row sets for a predicate under NOT or inside another expression, for SELECT, DELETE and UPDATE (#1397).
 * Covers the NULL-free parity matrix across `auto` and `legacy`, three-valued NULL/omitted-attribute exclusion
 * across `auto` and `new` (proving v2 answers directly without fallback), and `legacy`'s two-valued NULL row sets.
 */

import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sql-not-predicate');
const SCHEMA = 'data';
const TABLE = 'Item';
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb';

const SEED = [
	{ id: 'r1', c: 'alpha', a: 1, b: 2 },
	{ id: 'r2', c: 'alpha', a: 1, b: 3 },
	{ id: 'r3', c: 'beta', a: 2, b: 2 },
	{ id: 'r4', c: 'beta', a: 2, b: 3 },
	{ id: 'r5', c: 'gamma', a: 1, b: 1 },
	{ id: 'r6', c: 'gamma', a: 3, b: 3 },
	{ id: 'r7', c: 'delta', a: 3, b: 2 },
	{ id: 'r8', c: 'delta', a: 2, b: 1 },
	{ id: 'r9', c: 'alpha', a: 3, b: 1 },
].map((row) => ({ ...row, flag: 'none' }));
const ALL_IDS = SEED.map((row) => row.id);

const CASES: { where: string; expected: string[] }[] = [
	{ where: `NOT (c = 'alpha')`, expected: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'] },
	{ where: `NOT (c IN ('alpha', 'beta'))`, expected: ['r5', 'r6', 'r7', 'r8'] },
	{ where: `NOT (a > 1)`, expected: ['r1', 'r2', 'r5'] },
	{ where: `NOT (a < 3)`, expected: ['r6', 'r7', 'r9'] },
	{ where: `NOT (a >= 3)`, expected: ['r1', 'r2', 'r3', 'r4', 'r5', 'r8'] },
	{ where: `NOT (a <= 1)`, expected: ['r3', 'r4', 'r6', 'r7', 'r8', 'r9'] },
	{ where: `NOT (a = 1 AND b = 2)`, expected: ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'] },
	{ where: `NOT (a = 1 OR b = 2)`, expected: ['r4', 'r6', 'r8', 'r9'] },
	{ where: `NOT (NOT (c = 'alpha'))`, expected: ['r1', 'r2', 'r9'] },
	{ where: `a > 1 AND NOT (a = 3)`, expected: ['r3', 'r4', 'r8'] },
	{ where: `c = 'alpha' AND NOT (b = 1)`, expected: ['r1', 'r2'] },
	{ where: `a < 3 AND NOT (c IN ('alpha', 'gamma'))`, expected: ['r3', 'r4', 'r8'] },
	{ where: `a = 1 AND (b = 2 OR c = 'gamma')`, expected: ['r1', 'r5'] },
	{ where: `(c = 'alpha') = false`, expected: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'] },
	{ where: `IIF(c = 'alpha', 0, 1) = 1`, expected: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'] },
	// controls: forms that never relied on a negated pre-fetch
	{ where: `c != 'alpha'`, expected: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'] },
	{ where: `c NOT IN ('alpha', 'beta')`, expected: ['r5', 'r6', 'r7', 'r8'] },
	{ where: `NOT (c IS NULL)`, expected: ALL_IDS },
];

// Self-join on c: the alpha group is r1, r2, r9; gamma is r5, r6.
const SELF_JOIN_CASES: { where: string; expected: string[] }[] = [
	{ where: `l.a = 1 AND NOT (r.a = 3)`, expected: ['r1:r1', 'r1:r2', 'r2:r1', 'r2:r2', 'r5:r5'] },
	{ where: `l.a = 1 AND (r.a = 2 OR r.a = 3)`, expected: ['r1:r9', 'r2:r9', 'r5:r6'] },
	{ where: `l.a = 1 AND r.a > 1`, expected: ['r1:r9', 'r2:r9', 'r5:r6'] },
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

// `legacy` exercises SQLSearch directly; `auto` exercises sqlEngine v2 (falling back to legacy only for expressions
// v2 still rejects, such as IIF or standalone unindexed predicates).
for (const sqlEngine of ['auto', 'legacy']) {
	suite(
		`SQL NOT predicate row sets [storage=${ENGINE}, sql.engine=${sqlEngine}]`,
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

			for (const { where, expected } of CASES) {
				test(`SELECT WHERE ${where}`, async () => {
					const rows = await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${where}`);
					deepStrictEqual(sortedIds(rows), expected);
				});
			}

			for (const { where, expected } of SELF_JOIN_CASES) {
				test(`SELECT self-join WHERE ${where}`, async () => {
					const rows = await sql(
						client,
						`SELECT l.id AS lid, r.id AS rid FROM ${SCHEMA}.${TABLE} l JOIN ${SCHEMA}.${TABLE} r ON l.c = r.c WHERE ${where}`
					);
					deepStrictEqual(rows.map((row) => `${row.lid}:${row.rid}`).sort(), expected);
				});
			}

			for (const { where, expected } of CASES) {
				test(`DELETE WHERE ${where}`, async () => {
					await reseed(client);
					const result = await sql(client, `DELETE FROM ${SCHEMA}.${TABLE} WHERE ${where}`);
					deepStrictEqual([...result.deleted_hashes].sort(), expected);
					deepStrictEqual(
						sortedIds(await readTable(client)),
						ALL_IDS.filter((id) => !expected.includes(id))
					);
				});
			}

			for (const { where, expected } of CASES) {
				test(`UPDATE WHERE ${where}`, async () => {
					await reseed(client);
					const result = await sql(client, `UPDATE ${SCHEMA}.${TABLE} SET flag = 'hit' WHERE ${where}`);
					deepStrictEqual([...result.update_hashes].sort(), expected);
					deepStrictEqual(sortedIds((await readTable(client)).filter((row) => row.flag === 'hit')), expected);
				});
			}
		}
	);
}

const SEED_WITH_NULLS: Record<string, any>[] = [
	...SEED,
	{ id: 'r_null', c: null, a: null, b: null, flag: 'none' },
	{ id: 'r_absent', flag: 'none' },
	{ id: 'r_alpha_bnull', c: 'alpha', a: 2, b: null, flag: 'none' },
	{ id: 'r_anull_b3', c: 'beta', a: null, b: 3, flag: 'none' },
	{ id: 'r_a1_bnull', c: 'beta', a: 1, b: null, flag: 'none' },
];
const ALL_IDS_WITH_NULLS = SEED_WITH_NULLS.map((row) => row.id).sort();

const NULL_PARITY_CASES: {
	parenWhere: string;
	unparenWhere: string;
	expected: string[];
	legacyExpected: string[];
	legacyUnparenExpected?: string[];
}[] = [
	{
		parenWhere: `NOT (c = 'alpha')`,
		unparenWhere: `NOT c = 'alpha'`,
		expected: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r_a1_bnull', 'r_anull_b3'],
		legacyExpected: ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r_a1_bnull', 'r_absent', 'r_anull_b3', 'r_null'],
	},
	{
		parenWhere: `c = 'alpha' AND NOT (b = 1)`,
		unparenWhere: `c = 'alpha' AND NOT b = 1`,
		expected: ['r1', 'r2'],
		legacyExpected: ['r1', 'r2', 'r_alpha_bnull'],
	},
	{
		parenWhere: `NOT (a = 1 OR b = 2)`,
		unparenWhere: `NOT a = 1 AND NOT b = 2`,
		expected: ['r4', 'r6', 'r8', 'r9'],
		legacyExpected: ['r4', 'r6', 'r8', 'r9', 'r_absent', 'r_alpha_bnull', 'r_anull_b3', 'r_null'],
	},
	{
		parenWhere: `NOT (a = 1 AND b = 2)`,
		unparenWhere: `NOT a = 1 OR NOT b = 2`,
		expected: ['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r_alpha_bnull', 'r_anull_b3'],
		legacyExpected: [
			'r2',
			'r3',
			'r4',
			'r5',
			'r6',
			'r7',
			'r8',
			'r9',
			'r_a1_bnull',
			'r_absent',
			'r_alpha_bnull',
			'r_anull_b3',
			'r_null',
		],
	},
	{
		parenWhere: `NOT (a > 1)`,
		unparenWhere: `NOT a > 1`,
		expected: ['r1', 'r2', 'r5', 'r_a1_bnull'],
		legacyExpected: ['r1', 'r2', 'r5', 'r_a1_bnull', 'r_absent', 'r_anull_b3', 'r_null'],
	},
	{
		// In legacy AlaSQL, `c NOT IN (...)` emits a `!= null` check while `NOT (c IN (...))` uses JS `!`, so the two
		// spellings disagree on NULL rows in legacy; v2 normalizes both to `negated: true` and excludes NULLs for both.
		parenWhere: `NOT (c IN ('alpha', 'beta'))`,
		unparenWhere: `c NOT IN ('alpha', 'beta')`,
		expected: ['r5', 'r6', 'r7', 'r8'],
		legacyExpected: ['r5', 'r6', 'r7', 'r8', 'r_absent', 'r_null'],
		legacyUnparenExpected: ['r5', 'r6', 'r7', 'r8'],
	},
];

async function reseedWithNulls(client: Client): Promise<void> {
	await client
		.req()
		.send({ operation: 'upsert', schema: SCHEMA, table: TABLE, records: SEED_WITH_NULLS })
		.timeout(60_000)
		.expect(200);
	deepStrictEqual(sortedIds(await readTable(client)), ALL_IDS_WITH_NULLS);
}

// Running under both `auto` and `new` proves v2 answers every parenthesized NOT shape directly (under `new`, any
// EngineUnsupportedError fails the request instead of falling back to legacy).
for (const sqlEngine of ['auto', 'new']) {
	suite(
		`SQL parenthesized NOT with NULL and omitted attributes [storage=${ENGINE}, sql.engine=${sqlEngine}]`,
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
				await reseedWithNulls(client);
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			for (const { parenWhere, unparenWhere, expected } of NULL_PARITY_CASES) {
				test(`SELECT WHERE ${parenWhere} matches ${unparenWhere} and excludes NULLs`, async () => {
					const parenRows = await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${parenWhere}`);
					const unparenRows = await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${unparenWhere}`);
					deepStrictEqual(sortedIds(unparenRows), expected);
					deepStrictEqual(sortedIds(parenRows), expected);
				});
			}

			for (const { parenWhere, unparenWhere, expected } of NULL_PARITY_CASES) {
				test(`DELETE WHERE ${parenWhere} matches ${unparenWhere} and preserves NULLs`, async () => {
					await reseedWithNulls(client);
					const unparenResult = await sql(client, `DELETE FROM ${SCHEMA}.${TABLE} WHERE ${unparenWhere}`);
					deepStrictEqual([...unparenResult.deleted_hashes].sort(), expected);

					await reseedWithNulls(client);
					const parenResult = await sql(client, `DELETE FROM ${SCHEMA}.${TABLE} WHERE ${parenWhere}`);
					deepStrictEqual([...parenResult.deleted_hashes].sort(), expected);
					deepStrictEqual(
						sortedIds(await readTable(client)),
						ALL_IDS_WITH_NULLS.filter((id) => !expected.includes(id))
					);
				});
			}

			for (const { parenWhere, unparenWhere, expected } of NULL_PARITY_CASES) {
				test(`UPDATE WHERE ${parenWhere} matches ${unparenWhere} and preserves NULLs`, async () => {
					await reseedWithNulls(client);
					const unparenResult = await sql(client, `UPDATE ${SCHEMA}.${TABLE} SET flag = 'hit' WHERE ${unparenWhere}`);
					deepStrictEqual([...unparenResult.update_hashes].sort(), expected);

					await reseedWithNulls(client);
					const parenResult = await sql(client, `UPDATE ${SCHEMA}.${TABLE} SET flag = 'hit' WHERE ${parenWhere}`);
					deepStrictEqual([...parenResult.update_hashes].sort(), expected);
					deepStrictEqual(sortedIds((await readTable(client)).filter((row) => row.flag === 'hit')), expected);
				});
			}
		}
	);
}

// Legacy AlaSQL evaluates `NOT` with JavaScript two-valued logic (`!(null == 'alpha')` is true), so NULL and
// omitted-attribute rows are included under `NOT` — contrasting with v2's SQL three-valued logic above while still
// keeping parenthesized and unparenthesized `NOT` identical (#3202).
suite(
	`SQL parenthesized NOT with NULL and omitted attributes [storage=${ENGINE}, sql.engine=legacy]`,
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: Client;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
				env: { HARPER_SQL_ENGINE: 'legacy' },
			});
			client = createApiClient(ctx.harper);
			await restartHttpWorkers(client, `/${TABLE}/`, 120_000);
			await reseedWithNulls(client);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		for (const { parenWhere, unparenWhere, legacyExpected, legacyUnparenExpected } of NULL_PARITY_CASES) {
			test(`SELECT WHERE ${parenWhere} vs ${unparenWhere} under legacy 2-valued logic`, async () => {
				const parenRows = await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${parenWhere}`);
				const unparenRows = await sql(client, `SELECT id FROM ${SCHEMA}.${TABLE} WHERE ${unparenWhere}`);
				deepStrictEqual(sortedIds(parenRows), legacyExpected);
				deepStrictEqual(sortedIds(unparenRows), legacyUnparenExpected ?? legacyExpected);
			});
		}
	}
);
