'use strict';

// `evaluateSQL` honors a supplied `parsed_sql_object` verbatim and skips parsing, so one carrying
// `permissions_checked: true` would execute an AST no authorization check ever saw. Both the
// dispatch (`chooseOperation`) and the job worker (`jobProcess`) strip it through this function;
// jobProcess itself is a worker IIFE keyed off `process.env` and cannot be imported, which is why
// the invariant lives here instead of inline at each call site.

const assert = require('assert');
const { stripSuppliedParsedSqlObject } = require('#src/server/serverHelpers/requestSanitization');

const forgedAst = () => ({ variant: 'select', permissions_checked: true, ast: { statements: [{ forged: true }] } });

describe('stripSuppliedParsedSqlObject', () => {
	it('removes a top-level parsed_sql_object', () => {
		const request = { operation: 'export_local', parsed_sql_object: forgedAst() };

		stripSuppliedParsedSqlObject(request);

		assert.strictEqual(request.parsed_sql_object, undefined);
	});

	it('removes one nested on search_operation', () => {
		const request = {
			operation: 'export_local',
			search_operation: { operation: 'sql', sql: 'SELECT * FROM data.dog', parsed_sql_object: forgedAst() },
		};

		stripSuppliedParsedSqlObject(request);

		assert.strictEqual(request.search_operation.parsed_sql_object, undefined);
	});

	// Both positions in one call: chooseOperation overwrites the top-level object with its own parse,
	// but only inside its SQL branch, so a non-SQL job can carry one through to the persisted row.
	it('removes both positions at once', () => {
		const request = {
			operation: 'export_local',
			parsed_sql_object: forgedAst(),
			search_operation: { operation: 'search_by_value', parsed_sql_object: forgedAst() },
		};

		stripSuppliedParsedSqlObject(request);

		assert.strictEqual(request.parsed_sql_object, undefined);
		assert.strictEqual(request.search_operation.parsed_sql_object, undefined);
	});

	// The authorized statement is what must survive, since the worker re-parses from it.
	it('leaves the rest of the request intact', () => {
		const request = {
			operation: 'export_local',
			path: './',
			search_operation: { operation: 'sql', sql: 'SELECT * FROM data.dog', parsed_sql_object: forgedAst() },
		};

		stripSuppliedParsedSqlObject(request);

		assert.strictEqual(request.search_operation.sql, 'SELECT * FROM data.dog');
		assert.strictEqual(request.operation, 'export_local');
		assert.strictEqual(request.path, './');
	});

	it('tolerates a request with neither position, and a missing request', () => {
		const request = { operation: 'export_local', search_operation: { operation: 'search_by_value' } };

		assert.doesNotThrow(() => stripSuppliedParsedSqlObject(request));
		assert.doesNotThrow(() => stripSuppliedParsedSqlObject(undefined));
		assert.strictEqual(request.operation, 'export_local');
	});
});
