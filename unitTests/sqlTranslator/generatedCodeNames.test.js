'use strict';

const assert = require('node:assert');
const { convertSQLToAST } = require('#src/sqlTranslator/index');

// AlaSQL compiles a statement to JavaScript and pastes names from the SQL text into that code between
// single quotes. Before 4.22.4 a name holding a backslash or a line break ended the string early, and the rest
// of the text ran as code (GHSA-67vj-hh8j-j94f). The fixed parser refuses such a name; this keeps the
// dependency pin from slipping back to a release that does not.
describe('SQL names that would escape the generated code (GHSA-67vj-hh8j-j94f)', function () {
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

	it('still accepts names and select-list aliases that are safe to paste, quotes included in an alias', function () {
		for (const sql of [
			'SELECT a FROM data.[ok name]',
			'SELECT [ok name] FROM data.t',
			`SELECT a AS "Customer's name" FROM data.t`,
			`SELECT a AS "x'y", COUNT(*) FROM data.t GROUP BY a`,
			"SELECT a FROM data.t WHERE a = 'O''Brien'",
		]) {
			assert.ok(convertSQLToAST(sql).ast.statements.length > 0, sql);
		}
	});
});
