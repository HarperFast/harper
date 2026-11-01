'use strict';
/**
 * Legacy SQL runs the re-parse of a statement's SQL text, so that text must parse back to the statement that
 * was authorized. End-to-end coverage is in integrationTests/security/sql-attribute-perms.test.ts.
 */

const assert = require('assert');
const sinon = require('sinon');
const alasql = require('alasql');

const sqlTranslator = require('#js/sqlTranslator/index');
const opAuth = require('#src/utility/operation_authorization');
const sqlEngineRouter = require('#src/sqlEngine/router');
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
				if (text === undefined) continue;
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
		]) {
			const before = parse(`SELECT ${json} AS v FROM dev.t`).columns;
			const after = reparsed(`SELECT ${json} AS v FROM dev.t`).columns;
			assert.strictEqual(after.length, 1, json);
			assert.strictEqual(JSON.stringify(after[0].value), JSON.stringify(before[0].value), json);
		}
	});

	it('refuses a name that backticks or brackets cannot hold', function () {
		for (const sql of [
			'SELECT [x`,ssn,`y] FROM dev.t',
			'SELECT `x],ssn,[y` FROM dev.t',
			'SELECT label AS [x`,ssn,`y] FROM dev.t',
			'SELECT label AS `[x` FROM dev.t',
			"SELECT label FROM dev.t WHERE [x`,ssn,`y] = 'a'",
		]) {
			assertUnwritable(sql);
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
		]) {
			assertLegacySqlText(parse(sql));
		}
	});

	describe('engine routing', function () {
		const sandbox = sinon.createSandbox();
		afterEach(() => sandbox.restore());

		it('refuses an unwritable statement on the legacy path before it runs', async function () {
			sandbox.stub(opAuth, 'verifyPermsAST').returns(null);
			sandbox.stub(sqlEngineRouter, 'route').callsFake((opts, cb) => opts.legacy(opts.statement, cb));
			const err = await new Promise((resolve) =>
				sqlTranslator.evaluateSQL({ sql: 'SELECT [x`,ssn,`y] FROM dev.dog', hdb_user: { username: 'u' } }, resolve)
			);
			assert.strictEqual(err?.statusCode, 400);
		});
	});
});
