'use strict';

const assert = require('node:assert');
const alasql = require('alasql');

const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { evaluateSQL } = require('#src/sqlTranslator/index');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');
const mutation = require('#src/sqlEngine/executor/runMutation');
const { normalizeStatement } = require('#src/sqlEngine/parser/normalizer');
const { registerStandardFunctions } = require('#src/sqlEngine/functions/standard');
const { registerAggregateFunctions } = require('#src/sqlEngine/functions/aggregates');
const { EngineUnsupportedError } = require('#src/sqlEngine/errors');
const { transaction } = require('#src/resources/transaction');

const normalize = (variant, sql) => normalizeStatement(alasql.parse(sql).statements[0], variant);

describe('sqlEngine normalizer refuses constructs it does not model', () => {
	before(() => {
		registerStandardFunctions();
		registerAggregateFunctions();
	});

	const REFUSED = [
		['select', 'SELECT id FROM dev.t WHERE id = 1 AND EXISTS (SELECT id FROM dev.u WHERE id = 99)', 'exists'],
		['select', 'SELECT id FROM dev.t WHERE id = 1 AND NOT EXISTS (SELECT id FROM dev.u)', 'exists'],
		['select', 'SELECT EXISTS (SELECT id FROM dev.u) AS e FROM dev.t', 'exists'],
		['select', 'SELECT id FROM dev.t WHERE id = 1 AND `` return false ``', 'could not normalize'],
		['select', 'SELECT id FROM dev.t WHERE a = {x: 1}', 'could not normalize'],
		['select', 'SELECT id FROM dev.t WHERE a IN (SELECT id FROM dev.u)', 'queries'],
		['select', 'SELECT id FROM dev.t UNION SELECT id FROM dev.u', 'union'],
		['select', 'SELECT id FROM dev.t UNION ALL SELECT id FROM dev.u', 'unionall'],
		['select', 'SELECT id FROM dev.t EXCEPT SELECT id FROM dev.u', 'except'],
		['select', 'SELECT id FROM dev.t INTERSECT SELECT id FROM dev.u', 'intersect'],
		['select', 'SELECT id FROM dev.t UNION CORRESPONDING SELECT id FROM dev.u', 'union'],
		['select', 'SELECT DISTINCT ON (a) a, b FROM dev.t', 'distinctOn'],
		['select', 'SELECT VALUE id FROM dev.t', 'modifier'],
		['select', 'SELECT ROW id, a FROM dev.t', 'modifier'],
		['select', 'SELECT COLUMN id FROM dev.t', 'modifier'],
		['select', 'SELECT MATRIX id FROM dev.t', 'modifier'],
		['select', 'SELECT INDEX id FROM dev.t', 'modifier'],
		['select', 'SELECT RECORDSET id FROM dev.t', 'modifier'],
		['select', 'SELECT id INTO dev.x FROM dev.t', 'into'],
		['select', 'SELECT * FROM dev.t PIVOT (SUM(a) FOR b IN (1, 2))', 'pivot'],
		['select', 'SELECT * FROM dev.t UNPIVOT (a FOR b IN (c, d))', 'unpivot'],
		['select', 'EXPLAIN SELECT id FROM dev.t', 'explain'],
		['select', 'SELECT id FROM dev.t ORDER BY a COLLATE NOCASE', 'nocase'],
		['select', 'SELECT id FROM dev.t ORDER BY a COLLATE NOCASE DESC', 'nocase'],
		['select', 'SELECT id FROM dev.t ORDER BY a ASC NULLS LAST', 'nullsOrder'],
		['select', 'SELECT id FROM dev.t ORDER BY a ASC NULLS FIRST', 'nullsOrder'],
		['select', 'SELECT id FROM dev.t ORDER BY a DESC NULLS FIRST', 'nullsOrder'],
		['select', 'SELECT id, a FROM dev.t ORDER BY 2', 'column position'],
		['select', 'SELECT SUM(a) OVER (PARTITION BY b) FROM dev.t', 'over'],
		['select', 'SELECT COUNT(*) OVER () FROM dev.t', 'over'],
		['select', 'SELECT LOWER(a) OVER (ORDER BY b) FROM dev.t', 'over'],
		['select', 'SELECT ROW_NUMBER() OVER (ORDER BY a) FROM dev.t', 'over'],
		['select', "SELECT GROUP_CONCAT(a ORDER BY a DESC SEPARATOR '-') FROM dev.t", 'order'],
		['select', 'SELECT NEW Foo(1) FROM dev.t', 'newid'],
		['select', 'SELECT MAX(a, b) FROM dev.t', 'arguments'],
		['select', 'SELECT MIN(a, b) FROM dev.t', 'arguments'],
		['select', 'SELECT PROD(a, b) FROM dev.t', 'several arguments'],
		['select', 'SELECT MEDIAN(a, b) FROM dev.t', 'several arguments'],
		['select', 'SELECT * FROM dev.t NATURAL JOIN dev.u', 'natural'],
		['select', 'SELECT * FROM dev.t JOIN (SELECT * FROM dev.u) x ON x.a = t.a', 'select'],
		['delete', 'DELETE FROM dev.t WHERE id = 1 AND EXISTS (SELECT id FROM dev.u WHERE id = 99)', 'exists'],
		['delete', 'DELETE FROM dev.t WHERE id = 1 OR EXISTS (SELECT id FROM dev.u)', 'exists'],
		['delete', 'DELETE FROM dev.t WHERE id = 1 AND `` return false ``', 'could not normalize'],
		['delete', 'DELETE FROM dev.t WHERE id IN (SELECT id FROM dev.u)', 'queries'],
		['update', 'UPDATE dev.t SET a = 1 WHERE id = 1 AND EXISTS (SELECT id FROM dev.u WHERE id = 99)', 'exists'],
		['update', 'UPDATE dev.t SET a = {x: 1} WHERE id = 1', 'could not normalize'],
	];

	for (const [variant, sql, fragment] of REFUSED) {
		it(`refuses ${sql}`, () => {
			assert.throws(
				() => normalize(variant, sql),
				(error) => {
					assert.ok(error instanceof EngineUnsupportedError, `${error?.name}: ${error?.message}`);
					assert.ok(
						error.reason.toLowerCase().includes(fragment.toLowerCase()),
						`"${error.reason}" does not mention "${fragment}"`
					);
					return true;
				}
			);
		});
	}

	const SUPPORTED = [
		['select', "SELECT id FROM dev.t WHERE a = 1 AND b = 'x' AND c = true AND d = false AND e = 0 AND f = NULL"],
		['select', 'SELECT id FROM dev.t WHERE a IS NULL AND b IS NOT NULL'],
		['select', "SELECT id FROM dev.t WHERE a IN (1, 'x', 0, false) AND b NOT IN (3) AND c BETWEEN 1 AND 2"],
		['select', "SELECT id FROM dev.t WHERE name LIKE 'a%' AND name NOT LIKE 'b!_' ESCAPE '!'"],
		['select', 'SELECT ALL id FROM dev.t'],
		['select', 'SELECT DISTINCT a FROM dev.t'],
		['select', 'SELECT TOP 3 id FROM dev.t'],
		['select', 'SELECT id AS i, a + 1 AS b, a || b AS c FROM dev.t AS x WHERE (a = 1) OR NOT b = 2'],
		['select', 'SELECT id FROM dev.t ORDER BY a ASC, b DESC, c'],
		['select', 'SELECT id FROM dev.t ORDER BY a + b LIMIT 3 OFFSET 1'],
		['select', "SELECT id, a FROM dev.t ORDER BY (2), '2'"],
		['select', 'SELECT COUNT(*), COUNT(a), COUNT(DISTINCT a), SUM(a), AVG(a), MIN(a), MAX(a) FROM dev.t'],
		['select', 'SELECT a, COUNT(*) AS n FROM dev.t GROUP BY a HAVING COUNT(*) > 1 ORDER BY n DESC'],
		['select', 'SELECT LOWER(a), UPPER(b), LENGTH(c) FROM dev.t'],
		['select', 'SELECT PROD(a), MEDIAN(a) FROM dev.t'],
		['select', 'SELECT t.id, u.a FROM dev.t AS t JOIN dev.u AS u ON t.id = u.id LEFT JOIN dev.w AS w ON w.id = t.id'],
		['select', 'SELECT t.id FROM dev.t AS t INNER JOIN dev.u AS u USING (id) CROSS JOIN dev.w'],
		['select', 'SELECT * FROM dev.t, dev.u WHERE t.id = u.id'],
		['insert', "INSERT INTO dev.t (id, a, b, c) VALUES (1, 'x', true, NULL), (2, 'y', false, 0)"],
		['update', "UPDATE dev.t SET a = a + 1, b = 'x' WHERE id = 1 AND c IS NULL"],
		['delete', 'DELETE FROM dev.t WHERE id = 1 AND a > 2'],
		['delete', 'DELETE FROM dev.t'],
	];

	for (const [variant, sql] of SUPPORTED) {
		it(`still normalizes ${sql}`, () => {
			assert.strictEqual(normalize(variant, sql).kind, variant);
		});
	}

	it('keeps all four literal classes and their types', () => {
		const { where } = normalize('select', "SELECT id FROM dev.t WHERE a = 1 AND b = 'x' AND c = false AND d = NULL");
		const types = [];
		(function collect(node) {
			if (node === null || typeof node !== 'object') return;
			if (node.kind === 'literal') types.push(node.sqlType);
			for (const child of Object.values(node)) collect(child);
		})(where);
		assert.deepStrictEqual(types, ['number', 'string', 'boolean', 'unknown']);
	});

	it('leaves a malformed LIKE a 400 instead of a fallback', () => {
		assert.throws(
			() => normalize('select', "SELECT id FROM dev.t WHERE name LIKE 'a!' ESCAPE '!'"),
			(error) => error.statusCode === 400 && !(error instanceof EngineUnsupportedError)
		);
	});
});

describe('sqlEngine auto falls back to legacy for constructs v2 does not model', function () {
	this.timeout(120000);

	const TABLE = 'test.SqlUnsupportedConstruct';
	const SEED = [
		{ id: 1, grp: 'g1', name: 'b', n: 10, tag: 'seed' },
		{ id: 2, grp: 'g1', name: 'A', n: 20, tag: 'seed' },
		{ id: 3, grp: 'g2', name: 'c', n: 30, tag: 'seed' },
		{ id: 4, grp: 'g2', name: 'B', n: 40, tag: 'seed' },
		{ id: 5, grp: 'g2', name: 'a', n: 50, tag: 'seed' },
	];
	let T;
	let originalEngine;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		originalEngine = process.env.HARPER_SQL_ENGINE;
		mutation._setTransactionRunner(transaction);
		T = table({
			table: 'SqlUnsupportedConstruct',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'grp', indexed: true },
				{ name: 'name' },
				{ name: 'n', type: 'Int' },
				{ name: 'tag' },
			],
		});
	});

	beforeEach(reseed);

	after(async () => {
		mutation._setTransactionRunner(null);
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
		await T?.dropTable();
	});

	async function reseed() {
		for await (const { id } of T.search({ select: ['id'], allowFullScan: true })) await T.delete(id);
		for (const record of SEED) await T.put({ ...record });
		if (T.indexingOperation) await T.indexingOperation;
	}

	function sql(engine, text) {
		process.env.HARPER_SQL_ENGINE = engine;
		return runWithOperationAuthorizationBypass(
			true,
			() =>
				new Promise((resolve, reject) =>
					evaluateSQL({ sql: text, hdb_user: { username: 'test' } }, (error, result) =>
						error ? reject(error) : resolve(result)
					)
				)
		);
	}

	async function outcome(engine, text) {
		try {
			return { rows: await sql(engine, text) };
		} catch (error) {
			return { error: error.message };
		}
	}

	async function stored() {
		const rows = [];
		for await (const record of T.search({ select: ['id', 'tag'], allowFullScan: true })) rows.push(record);
		return rows.sort((a, b) => a.id - b.id);
	}

	// Every statement carries an indexed predicate: v2 answers only queries it can drive from an index, and one
	// that cannot falls back to legacy whatever the construct, which would make the comparison vacuous.
	const INDEXED = 'id > 0';
	const LEGACY_RUNS = [
		`SELECT DISTINCT ON (grp) grp, name FROM ${TABLE} WHERE ${INDEXED} ORDER BY grp, id`,
		`SELECT VALUE name FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
		`SELECT ROW id, name FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
		`SELECT COLUMN name FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
		`SELECT id, name FROM ${TABLE} WHERE ${INDEXED} ORDER BY name COLLATE NOCASE, id`,
		`SELECT id, name FROM ${TABLE} WHERE ${INDEXED} ORDER BY name COLLATE NOCASE DESC, id`,
		`SELECT id, n FROM ${TABLE} WHERE ${INDEXED} ORDER BY 2 DESC`,
		`SELECT id, n FROM ${TABLE} WHERE ${INDEXED} ORDER BY n ASC NULLS LAST`,
		`SELECT id, n FROM ${TABLE} WHERE ${INDEXED} ORDER BY n DESC NULLS FIRST`,
		`SELECT id, SUM(n) OVER (PARTITION BY grp) AS s FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
		`SELECT id, COUNT(*) OVER () AS c FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
		`SELECT id, LOWER(name) OVER (ORDER BY id) AS l FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
		`SELECT MAX(n, id) AS m FROM ${TABLE} WHERE ${INDEXED}`,
		`SELECT MIN(n, id) AS m FROM ${TABLE} WHERE ${INDEXED}`,
		`SELECT id FROM ${TABLE} WHERE id = 1 AND \`\`false\`\``,
		`SELECT id FROM ${TABLE} WHERE id = 1 AND \`\`true\`\``,
	];
	const LEGACY_FAILS = [
		`SELECT id FROM ${TABLE} WHERE id = 1 AND EXISTS (SELECT id FROM ${TABLE} WHERE n > 1000)`,
		`SELECT id FROM ${TABLE} WHERE id = 1 AND NOT EXISTS (SELECT id FROM ${TABLE} WHERE n = 20)`,
		`SELECT id FROM ${TABLE} WHERE id IN (SELECT id FROM ${TABLE} WHERE n > 20) ORDER BY id`,
		`SELECT id FROM ${TABLE} WHERE n <= 30 AND ${INDEXED} UNION SELECT id FROM ${TABLE} WHERE n >= 50`,
		`SELECT id FROM ${TABLE} WHERE n <= 30 AND ${INDEXED} UNION ALL SELECT id FROM ${TABLE} WHERE n <= 20`,
		`SELECT id FROM ${TABLE} WHERE ${INDEXED} EXCEPT SELECT id FROM ${TABLE} WHERE n >= 30`,
		`SELECT id FROM ${TABLE} WHERE ${INDEXED} INTERSECT SELECT id FROM ${TABLE} WHERE n >= 30`,
	];

	for (const [cases, legacyRuns] of [
		[LEGACY_RUNS, true],
		[LEGACY_FAILS, false],
	]) {
		for (const text of cases) {
			it(`auto does what legacy does for ${text}`, async () => {
				const legacy = await outcome('legacy', text);
				assert.strictEqual(legacy.error === undefined, legacyRuns, JSON.stringify(legacy).slice(0, 200));
				assert.deepStrictEqual(await outcome('auto', text), legacy);
				const v2 = await outcome('new', text);
				assert.ok(v2.error?.includes('unsupported query'), `new must refuse: ${JSON.stringify(v2).slice(0, 200)}`);
			});
		}
	}

	it('ORDER BY 2 sorts by the second selected column', async () => {
		const byName = await outcome('auto', `SELECT id, n FROM ${TABLE} WHERE ${INDEXED} ORDER BY n DESC`);
		const byPosition = await outcome('auto', `SELECT id, n FROM ${TABLE} WHERE ${INDEXED} ORDER BY 2 DESC`);
		assert.deepStrictEqual(byPosition, byName);
		assert.deepStrictEqual(
			byPosition.rows.map((row) => row.id),
			[5, 4, 3, 2, 1]
		);
	});

	describe('DELETE and UPDATE with a predicate v2 does not model', () => {
		const NO_ROWS = `EXISTS (SELECT id FROM ${TABLE} WHERE n > 1000)`;
		const ONE_ROW = `EXISTS (SELECT id FROM ${TABLE} WHERE n = 20)`;
		const FALSE_JS = '``false``';
		const TRUE_JS = '``true``';
		const UNCHANGED = [
			`DELETE FROM ${TABLE} WHERE id = 1 AND ${NO_ROWS}`,
			`DELETE FROM ${TABLE} WHERE id = 1 AND ${FALSE_JS}`,
			`UPDATE ${TABLE} SET tag = 'hit' WHERE id = 1 AND ${NO_ROWS}`,
			`UPDATE ${TABLE} SET tag = 'hit' WHERE id = 1 AND ${FALSE_JS}`,
		];
		const OTHERS = [
			`DELETE FROM ${TABLE} WHERE id = 1 AND ${ONE_ROW}`,
			`DELETE FROM ${TABLE} WHERE id = 1 OR ${NO_ROWS}`,
			`DELETE FROM ${TABLE} WHERE id = 1 AND ${TRUE_JS}`,
			`UPDATE ${TABLE} SET tag = 'hit' WHERE id = 1 AND ${ONE_ROW}`,
			`UPDATE ${TABLE} SET tag = 'hit' WHERE id = 1 AND ${TRUE_JS}`,
			`UPDATE ${TABLE} SET tag = 'hit' WHERE id = 1 AND id IN (SELECT id FROM ${TABLE} WHERE n = 20)`,
		];
		const seeded = SEED.map(({ id, tag }) => ({ id, tag }));

		for (const text of [...UNCHANGED, ...OTHERS]) {
			it(`auto does what legacy does for ${text}`, async () => {
				const legacy = await outcome('legacy', text);
				const legacyState = await stored();
				await reseed();
				assert.deepStrictEqual(await outcome('auto', text), legacy);
				assert.deepStrictEqual(await stored(), legacyState);
				if (UNCHANGED.includes(text)) assert.deepStrictEqual(legacyState, seeded);
			});

			it(`new refuses ${text} and writes nothing`, async () => {
				const refused = await outcome('new', text);
				assert.ok(refused.error?.includes('unsupported query'), JSON.stringify(refused));
				assert.deepStrictEqual(await stored(), seeded);
			});
		}

		it('a true JavaScript predicate changes exactly the target and a false one nothing', async () => {
			await sql('auto', `DELETE FROM ${TABLE} WHERE id = 1 AND ${FALSE_JS}`);
			assert.deepStrictEqual(await stored(), seeded);
			const deleted = await sql('auto', `DELETE FROM ${TABLE} WHERE id = 1 AND ${TRUE_JS}`);
			assert.deepStrictEqual(deleted.deleted_hashes, [1]);
			assert.deepStrictEqual(
				(await stored()).map((row) => row.id),
				[2, 3, 4, 5]
			);
			await sql('auto', `UPDATE ${TABLE} SET tag = 'hit' WHERE id = 2 AND ${FALSE_JS}`);
			const updated = await sql('auto', `UPDATE ${TABLE} SET tag = 'hit' WHERE id = 2 AND ${TRUE_JS}`);
			assert.deepStrictEqual(updated.update_hashes, [2]);
			assert.deepStrictEqual(
				(await stored()).map((row) => row.tag),
				['hit', 'seed', 'seed', 'seed']
			);
		});
	});

	describe('what v2 still runs', () => {
		const RUNS_ON_V2 = [
			`SELECT ALL id FROM ${TABLE} WHERE ${INDEXED} ORDER BY id`,
			`SELECT id, name FROM ${TABLE} WHERE id = 1 AND name = 'b' AND n >= 0 AND tag IS NOT NULL`,
			`SELECT id FROM ${TABLE} WHERE ${INDEXED} ORDER BY name DESC, id`,
			`SELECT id, n FROM ${TABLE} WHERE ${INDEXED} ORDER BY (2), id`,
			`SELECT COUNT(name) AS c, MAX(n) AS m FROM ${TABLE} WHERE ${INDEXED}`,
			`SELECT grp, SUM(n) AS s FROM ${TABLE} WHERE ${INDEXED} GROUP BY grp HAVING SUM(n) > 30`,
			`UPDATE ${TABLE} SET tag = 'hit' WHERE id = 1`,
			`DELETE FROM ${TABLE} WHERE id = 1`,
		];

		for (const text of RUNS_ON_V2) {
			it(`new runs ${text}`, async () => {
				const v2 = await outcome('new', text);
				assert.strictEqual(v2.error, undefined, v2.error);
				const v2State = await stored();
				await reseed();
				assert.deepStrictEqual(await outcome('auto', text), v2);
				assert.deepStrictEqual(await stored(), v2State);
			});
		}
	});

	it('a malformed LIKE is a 400 in auto as in new, not a fallback', async () => {
		const text = `SELECT id FROM ${TABLE} WHERE ${INDEXED} AND name LIKE 'a!' ESCAPE '!'`;
		const auto = await outcome('auto', text);
		assert.deepStrictEqual(auto, await outcome('new', text));
		assert.ok(auto.error, 'expected an error');
	});
});
