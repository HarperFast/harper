'use strict';

const assert = require('node:assert');
const { convertSQLToAST } = require('#src/sqlTranslator/index');

// AlaSQL 4.22.4 refuses these names while parsing (GHSA-67vj-hh8j-j94f); earlier releases paste them into generated code.
describe('SQL names that would escape the generated code', function () {
	function refusal(sql) {
		try {
			convertSQLToAST(sql);
		} catch (error) {
			return error;
		}
		assert.fail(`${JSON.stringify(sql)} parsed`);
	}

	for (const [description, sql] of [
		['a table name with a backslash', 'SELECT a FROM data.[t\\x]'],
		['a backticked table name with a backslash', 'SELECT a FROM data.`t\\x`'],
		['a column name ending in a backslash', 'SELECT [a\\] FROM data.t'],
		['a column name with a line break', 'SELECT [a\nb] FROM data.t'],
		['a table alias with a backslash', 'SELECT a FROM data.t AS [x\\y]'],
	]) {
		it(`refuses ${description} as a client error`, function () {
			const error = refusal(sql);
			assert.strictEqual(error.statusCode, 400);
			assert.match(error.message, /Not a valid name/);
		});
	}

	it('still parses names and result aliases that cannot break the generated code', function () {
		for (const sql of [
			'SELECT a FROM data.[ok name]',
			'SELECT [ok name] FROM data.t',
			`SELECT id AS "Customer's name" FROM data.t WHERE id = 1`,
			"SELECT a FROM data.t WHERE a = 'O''Brien'",
		]) {
			assert.ok(convertSQLToAST(sql).ast.statements.length > 0, sql);
		}
	});
});
