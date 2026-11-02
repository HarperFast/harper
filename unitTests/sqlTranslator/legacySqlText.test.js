'use strict';
/**
 * Legacy SQL runs the re-parse of a statement's SQL text, so that text must parse back to the statement that
 * was authorized. End-to-end coverage is in integrationTests/security/sql-attribute-perms.test.ts.
 */

const assert = require('assert');
const alasql = require('alasql');

const { assertLegacySqlText, installLegacySqlText, quoteString } = require('#src/sqlTranslator/legacySqlText');
const { backtickASTSchemaItems } = require('#src/utility/common_utils');

installLegacySqlText();

const parse = (sql) => alasql.parse(sql).statements[0];

// The text legacy SQL runs: Harper backticks names before writing the statement out.
function reparsed(sql) {
	const statement = parse(sql);
	assertLegacySqlText(statement);
	backtickASTSchemaItems(statement);
	return parse(statement.toString());
}

const assertUnwritable = (sql) =>
	assert.throws(
		() => assertLegacySqlText(parse(sql)),
		(err) => err.statusCode === 400,
		sql
	);

describe('legacy SQL text', function () {
	it('writes a string literal that spells out a column list as one literal', function () {
		for (const literal of ["'x'', ssn, ''y'", "'O''Brien'", "'x\\', ssn, \\'y'", "\"x'', ssn, ''y\""]) {
			const columns = reparsed(`SELECT ${literal} AS v FROM dev.t`).columns;
			assert.strictEqual(columns.length, 1, literal);
			assert.strictEqual(columns[0].value, parse(`SELECT ${literal} AS v FROM dev.t`).columns[0].value, literal);
		}
	});

	it('writes every short string of letters, quotes and backslashes back to its value, or refuses it', function () {
		const alphabet = ['a', "'", '\\'];
		let bodies = [''];
		for (let length = 0; length < 6; length++) {
			for (const body of bodies) {
				let columns;
				try {
					columns = parse(`SELECT '${body}' AS v FROM t`).columns;
				} catch {
					continue;
				}
				if (columns.length !== 1 || columns[0].as !== 'v') continue;
				const text = quoteString(columns[0].value);
				if (text === undefined) {
					assert.match(
						columns[0].value,
						/(^|[^\\])(\\\\)*\\$/,
						`only a trailing odd run of backslashes is refused: ${body}`
					);
					continue;
				}
				const again = parse(`SELECT ${text} AS v FROM t WHERE w = 'z'`).columns;
				assert.deepStrictEqual(
					again.map((c) => c.value),
					[columns[0].value],
					body
				);
			}
			bodies = bodies.flatMap((body) => alphabet.map((c) => body + c));
		}
	});

	it('writes JSON literal keys, strings and arrays back to the same value', function () {
		for (const json of [
			`{'k':'x"} , ssn , {"z":"y'}`,
			`{'x",ssn,"y':1}`,
			`{"k":'a"b', "n":@[1,'x''y',{"z":id}], "o":@{"p":'q'}}`,
			`@['x'', ssn, ''y']`,
			`{'a"", ssn, ""b':1}`,
			`{'a"", ssn, ""b''c':1}`,
		]) {
			const before = parse(`SELECT ${json} AS v FROM dev.t`).columns;
			const after = reparsed(`SELECT ${json} AS v FROM dev.t`).columns;
			assert.strictEqual(after.length, 1, json);
			assert.strictEqual(JSON.stringify(after[0].value), JSON.stringify(before[0].value), json);
		}
	});

	it('refuses a name that backticks, brackets or a bare name cannot hold', function () {
		for (const sql of [
			'SELECT [x`,ssn,`y] FROM dev.t',
			'SELECT `x],ssn,[y` FROM dev.t',
			'SELECT label AS [x`,ssn,`y] FROM dev.t',
			'SELECT label AS `[x` FROM dev.t',
			"SELECT label FROM dev.t WHERE [x`,ssn,`y] = 'a'",
			"SELECT 'x' AS [x`,ssn,`y] FROM dev.t",
			"SELECT 'x' AS `x],ssn,[y` FROM dev.t",
			"SELECT {'k':1} AS [x`,ssn,`y] FROM dev.t",
			'SELECT @`x,ssn` AS v FROM dev.t',
			'SELECT $[x,ssn] AS v FROM dev.t',
			'SELECT label->[x, ssn] AS v FROM dev.t',
			'SELECT label![x, ssn] AS v FROM dev.t',
		]) {
			assertUnwritable(sql);
		}
	});

	it('writes numbers in plain decimal, which reads back as the same number', function () {
		for (const literal of [
			'10000000000000000000000000',
			'0.0000001',
			'123.5',
			"{'a':0.0000001,'b':@[10000000000000000000000000]}",
		]) {
			const before = parse(`SELECT ${literal} AS v FROM dev.t`).columns;
			const after = reparsed(`SELECT ${literal} AS v FROM dev.t`).columns;
			assert.strictEqual(after.length, 1, literal);
			assert.deepStrictEqual(after[0].value, before[0].value, literal);
		}
		assertUnwritable(`SELECT ${'9'.repeat(400)} AS v FROM dev.t`);
		assertUnwritable(`SELECT {'a':${'9'.repeat(400)}} AS v FROM dev.t`);
	});

	it('refuses a statement whose text reads a column the statement does not, or reads it more often', function () {
		const writer = alasql.yy.StringValue.prototype.toString;
		alasql.yy.StringValue.prototype.toString = function () {
			return "'" + this.value + "'";
		};
		try {
			assertUnwritable("SELECT 'x'', ssn, ''y' AS v FROM dev.t");
			// `r` and `id` each appear elsewhere; `r.id` does not.
			assertUnwritable(
				"SELECT l.label, 'x'', r.id, ''y' AS v FROM dev.l AS l INNER JOIN dev.r AS r ON l.label = r.label WHERE l.id = 1"
			);
			assertUnwritable("UPDATE dev.t SET ssn = '1', label = CONCAT('x'', ssn, ''y') WHERE id = 1");
			assertUnwritable("SELECT COUNT(*) AS c, 'x'', *, ''y' AS v FROM dev.t");
			assertUnwritable("SELECT 'x''; SELECT ssn FROM dev.t; SELECT ''y' AS v FROM dev.t");
		} finally {
			alasql.yy.StringValue.prototype.toString = writer;
		}
	});

	it('refuses a string literal that has no spelling', function () {
		assertUnwritable("SELECT 'a\\' AS v FROM dev.t");
		assertUnwritable("UPDATE dev.t SET label = {'k':'a\\'} WHERE id = 1");
	});

	it('accepts ordinary statements', function () {
		for (const sql of [
			"SELECT d.name, COUNT(*) AS c FROM dev.t AS d INNER JOIN dev.u AS u ON d.id = u.tid WHERE d.x LIKE 'a%' GROUP BY d.name",
			"UPDATE dev.t SET label = CONCAT('a', id), meta = {'k':@[1,2]} WHERE id IN (1, 2) AND name IS NOT NULL",
			"DELETE FROM dev.t WHERE [first name] = 'O''Brien'",
			'SELECT DISTINCT lower(a) AS l FROM dev.t WHERE EXISTS (SELECT 1 FROM dev.u WHERE u.id = t.id) ORDER BY l DESC LIMIT 2',
			"SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END AS c, CAST(b AS INT) AS n FROM dev.t WHERE b NOT IN (1, 2)",
			'SELECT @x AS v, $1 AS w, ? AS z FROM dev.t',
			'SELECT label->x AS v, COUNT(*) AS `count`, `select` FROM dev.t GROUP BY label->x, `select`',
		]) {
			assertLegacySqlText(parse(sql));
		}
		const noReadableColumn = parse("SELECT * FROM dev.t WHERE label = 'a'");
		noReadableColumn.columns = [];
		assertLegacySqlText(noReadableColumn);
	});
});
