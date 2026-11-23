'use strict';
/**
 * The in-memory SQL engine runs legacy SQL's statements over the rows it fetched, and must return what AlaSQL 4
 * returned for them. memoryEngineGolden.json holds the expected result of each seeded workload (sqlWorkloads.js); it
 * was generated, and checked against AlaSQL itself, while AlaSQL was still a dependency.
 */
const assert = require('assert');
const crypto = require('crypto');
const { query, compile } = require('#src/sqlTranslator/memoryEngine/index');
const golden = require('./fixtures/memoryEngineGolden.json');
const { joinWorkloads, featureWorkloads } = require('./fixtures/sqlWorkloads');

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
