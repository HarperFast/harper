'use strict';
/**
 * The in-memory SQL engine runs legacy SQL's statements over the rows it fetched, and must return what AlaSQL 4
 * returned for them. memoryEngineGolden.json holds the expected result of each seeded workload (sqlWorkloads.js); it
 * was generated, and checked against AlaSQL itself, while AlaSQL was still a dependency.
 */
const assert = require('node:assert');
const crypto = require('node:crypto');
const { query, compile } = require('#src/sqlTranslator/memoryEngine/index');
const golden = require('./fixtures/memoryEngineGolden.json');
const {
	joinWorkloads,
	featureWorkloads,
	commaJoinWorkloads,
	onFunctionWorkloads,
	groupingSetWorkloads,
} = require('./fixtures/sqlWorkloads');

/** A canonical text of a result: key order, undefined, NaN, -0, Dates and bigints all count. */
function canon(value, seen = new Set()) {
	if (value === undefined) return 'u';
	if (typeof value === 'number') return Object.is(value, -0) ? 'n-0' : 'n' + String(value);
	if (typeof value === 'bigint') return 'b' + value;
	if (typeof value === 'string') return 's' + JSON.stringify(value);
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'function') return 'fn';
	if (value === null) return 'null';
	if (seen.has(value)) return 'cycle';
	seen.add(value);
	try {
		if (value instanceof Date) return 'D' + value.getTime();
		if (Array.isArray(value)) {
			const extra = Object.keys(value).filter((k) => !/^\d+$/.test(k));
			return (
				'[' +
				value.map((x) => canon(x, seen)).join(',') +
				(Object.keys(value).length !== value.length
					? '|' + extra.map((k) => k + ':' + canon(value[k], seen)).join(',')
					: '') +
				']'
			);
		}
		if (value.constructor && value.constructor.name === 'Recordset') return 'RS{' + canon(value.data, seen) + '}';
		return (
			'{' +
			Object.keys(value)
				.map((k) => JSON.stringify(k) + ':' + canon(value[k], seen))
				.join(',') +
			'}'
		);
	} finally {
		seen.delete(value);
	}
}

function digest({ sql, params }) {
	let result;
	try {
		result = query(sql, params);
	} catch {
		return 'error';
	}
	return crypto.createHash('sha1').update(canon(result)).digest('hex').slice(0, 16);
}

const values = (sql, rows, column = 'v') => query(sql, [rows]).map((row) => row[column]);

describe('in-memory SQL engine', function () {
	describe('matches the golden results', function () {
		// Some workloads turn Dates into text, which depends on the time zone; the fixture was generated in UTC.
		let timeZone;
		before(function () {
			timeZone = process.env.TZ;
			process.env.TZ = 'UTC';
		});
		after(function () {
			if (timeZone === undefined) delete process.env.TZ;
			else process.env.TZ = timeZone;
		});

		it('for joined, filtered, grouped and sorted statements', function () {
			const { seed, count, digests } = golden.joins;
			const mismatches = joinWorkloads(seed, count).filter((workload, i) => digest(workload) !== digests[i]);
			assert.deepStrictEqual(
				mismatches.map((w) => w.sql),
				[]
			);
		});

		it('for modifiers, set operations, window aggregates and subqueries', function () {
			const { seed, count, digests } = golden.features;
			const mismatches = featureWorkloads(seed, count).filter((workload, i) => digest(workload) !== digests[i]);
			assert.deepStrictEqual(
				mismatches.map((w) => w.sql),
				[]
			);
		});

		it('for joins linked through WHERE', function () {
			const { seed, count, digests } = golden.commaJoins;
			const mismatches = commaJoinWorkloads(seed, count).filter((workload, i) => digest(workload) !== digests[i]);
			assert.deepStrictEqual(
				mismatches.map((w) => w.sql),
				[]
			);
		});

		it('for GROUP BY ROLLUP, CUBE and GROUPING SETS', function () {
			const { seed, count, digests } = golden.groupingSets;
			const mismatches = groupingSetWorkloads(seed, count).filter((workload, i) => digest(workload) !== digests[i]);
			assert.deepStrictEqual(
				mismatches.map((w) => w.sql),
				[]
			);
		});

		it('for equality joins whose ON calls a function', function () {
			const { seed, count, digests } = golden.onFunctionJoins;
			const mismatches = onFunctionWorkloads(seed, count).filter((workload, i) => digest(workload) !== digests[i]);
			assert.deepStrictEqual(
				mismatches.map((w) => w.sql),
				[]
			);
		});
	});

	describe('legacy semantics', function () {
		it('compares = strictly and <> loosely', function () {
			const rows = [[1], ['1'], [2]];
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t WHERE [0] = 1', rows), [1]);
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t WHERE [0] <> 1', rows), [2]);
		});

		it('makes a comparison with a NULL, missing or NaN operand undefined', function () {
			const rows = [[null], [undefined], [NaN], [5]];
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t WHERE [0] > 1', rows), [5]);
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t WHERE [0] IS NULL', rows), [null, undefined]);
		});

		it('applies LIMIT only when it is not zero', function () {
			const rows = [[1], [2], [3]];
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t LIMIT 0', rows), [1, 2, 3]);
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t LIMIT 1 OFFSET 1', rows), [2]);
		});

		it('joins an equality ON by the text of its keys and fills an unmatched LEFT JOIN row', function () {
			const left = [[1], [2]];
			const right = [['1', 'one']];
			const rows = query('SELECT a.[0] AS [k], b.[1] AS [name] FROM ? AS a LEFT JOIN ? AS b ON a.[0] = b.[0]', [
				left,
				right,
			]);
			assert.deepStrictEqual(rows, [
				{ k: 1, name: 'one' },
				{ k: 2, name: undefined },
			]);
		});

		it('returns 0 for COUNT and SUM over no rows, and nothing for MIN', function () {
			assert.deepStrictEqual(query('SELECT COUNT(*) AS [c], SUM([0]) AS [s], MIN([0]) AS [m] FROM ? AS t', [[]]), [
				{ c: 0, s: 0, m: undefined },
			]);
		});

		it('evaluates the operand IFNULL and NULLIF repeat as often as AlaSQL did', function () {
			const reads = (fn) => {
				let n = 0;
				const row = {};
				Object.defineProperty(row, 0, { get: () => (n++, 5), enumerable: true });
				query(`SELECT ${fn}(t.[0], 3) AS v FROM ? AS t`, [[row]]);
				return n;
			};
			assert.strictEqual(reads('IFNULL'), 3);
			assert.strictEqual(reads('NULLIF'), 2);
		});

		it('reads JSON literal and subquery sources in FROM and JOIN', function () {
			const rows = [
				{ a: 1, b: 'x' },
				{ a: 2, b: 'y' },
			];
			assert.deepStrictEqual(query('SELECT 1 IN (SELECT 1 FROM @[1,2]) AS [func_val] FROM ?', [rows]), [
				{ func_val: true },
				{ func_val: true },
			]);
			assert.deepStrictEqual(query('SELECT * FROM @[{a: 5, b: 1}] AS x', [rows]), [{ a: 5, b: 1 }]);
			assert.deepStrictEqual(query('SELECT * FROM (SELECT t.a AS n, t.b AS m FROM ? AS t) AS z', [rows]), [
				{ n: 1, m: 'x' },
				{ n: 2, m: 'y' },
			]);
			assert.deepStrictEqual(
				query(
					'SELECT t.a AS v, s.c AS c FROM ? AS t LEFT JOIN (SELECT u.b AS b, COUNT(*) AS c FROM ? AS u GROUP BY u.b) AS s ON t.b = s.b',
					[rows, rows]
				),
				[
					{ v: 1, c: 1 },
					{ v: 2, c: 1 },
				]
			);
			assert.deepStrictEqual(query('SELECT COUNT(*) AS c FROM (SELECT t.a FROM ? AS t WHERE t.a > 1) AS z', [rows]), [
				{ c: 1 },
			]);
		});

		it('counts a function call that takes no arguments', function () {
			assert.deepStrictEqual(query('SELECT COUNT(CURRENT_TIMESTAMP) AS n FROM ? AS t', [[[1], [2]]]), [{ n: 2 }]);
		});

		it('looks up the rows a WHERE equality links instead of trying every pair', function () {
			const left = Array.from({ length: 400 }, (_, i) => [i]);
			const right = Array.from({ length: 400 }, (_, i) => [i, 'r' + i]);
			let reads = 0;
			const counted = right.map(
				(row) => new Proxy(row, { get: (target, key) => (key === '0' && reads++, target[key]) })
			);
			const rows = query('SELECT a.[0] AS k, b.[1] AS v FROM ? AS a, ? AS b WHERE a.[0] = b.[0]', [left, counted]);
			assert.strictEqual(rows.length, 400);
			assert.deepStrictEqual(rows[7], { k: 7, v: 'r7' });
			assert.ok(reads < 5000, `read b.[0] ${reads} times`);
		});

		it('joins tables linked out of FROM order through a later table, and returns rows in FROM order', function () {
			const size = 300;
			const table = (offset) => Array.from({ length: size }, (_, i) => [(i * 7 + offset) % size, offset + i]);
			const [a, b, c] = [table(1), table(2), table(3)];
			let reads = 0;
			const counted = c.map((row) => new Proxy(row, { get: (target, key) => (key === '0' && reads++, target[key]) }));
			const rows = query(
				'SELECT a.[1] AS x, b.[1] AS y, c.[1] AS z FROM ? AS a, ? AS b, ? AS c WHERE a.[0] = c.[0] AND b.[0] = c.[0]',
				[a, b, counted]
			);
			assert.strictEqual(rows.length, size);
			const expected = [];
			for (const ra of a) {
				for (const rb of b) {
					for (const rc of c) if (ra[0] === rc[0] && rb[0] === rc[0]) expected.push({ x: ra[1], y: rb[1], z: rc[1] });
				}
			}
			assert.deepStrictEqual(rows, expected);
			assert.ok(reads < 10 * size, `read c.[0] ${reads} times`);
		});

		it('sorts falsy values as empty text', function () {
			const rows = [[0], [-1], [null], ['a']];
			assert.deepStrictEqual(values('SELECT [0] AS [v] FROM ? AS t ORDER BY [0]', rows), [-1, 0, null, 'a']);
		});

		it('compiles an expression to a function of its parameters', function () {
			const statement = compile('SELECT a + 1 AS [func_val] FROM ?');
			assert.deepStrictEqual(statement([[{ a: 41 }]]), [{ func_val: 42 }]);
		});

		it('groups, joins and deduplicates inherited names as ordinary values', function () {
			const rows = () => [
				['__proto__', 1],
				['constructor', 2],
				['__proto__', 3],
				['toString', 4],
			];
			assert.deepStrictEqual(query('SELECT [0] AS k, SUM([1]) AS s FROM ? AS t GROUP BY [0]', [rows()]), [
				{ k: '__proto__', s: 4 },
				{ k: 'constructor', s: 2 },
				{ k: 'toString', s: 4 },
			]);
			assert.deepStrictEqual(values('SELECT DISTINCT [0] AS v FROM ? AS t', rows()), [
				'__proto__',
				'constructor',
				'toString',
			]);
			assert.deepStrictEqual(query('SELECT COUNT(DISTINCT [0]) AS c FROM ? AS t', [rows()]), [{ c: 3 }]);
			assert.strictEqual(
				query('SELECT a.[1] AS v FROM ? AS a JOIN ? AS b ON a.[0] = b.[0]', [rows(), rows()]).length,
				6
			);
			assert.deepStrictEqual(Object.keys(Object.prototype), []);
			assert.strictEqual(typeof Object.prototype['SUM([1])'], 'undefined');
		});

		it('refuses to evaluate JavaScript', function () {
			assert.throws(() => query('SELECT ``1 + 1`` AS v'), /JavaScript expressions are not supported/);
		});
	});
});
