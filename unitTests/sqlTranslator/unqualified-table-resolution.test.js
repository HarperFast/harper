'use strict';
/**
 * GHSA-5c29-q62v-jrwf — schema-unqualified table references must be resolved before
 * authorization, using the same default-database rule the SQL engine's binder applies.
 *
 * Previously a bare `FROM customers` left `databaseid` undefined, so the bucket recorded no
 * affected schema/table at all and verifyPermsAST authorized the statement against an empty
 * map — while the engine went on to resolve the same bare name and touch a real table.
 *
 * These cover the resolution layer directly; the end-to-end authorization behavior is covered
 * by integrationTests/security/sql-unqualified-table-authz.test.ts.
 */

const assert = require('assert');
const alasql = require('alasql');

const bucketModule = require('#src/sqlTranslator/sql_statement_bucket');
const SqlStatementBucket = bucketModule.default;
const { statementHasTableTarget } = bucketModule;
const { _setDatabasesLoader } = require('#src/sqlEngine/binder/defaultDatabase');

/** Two databases; `orders` is unique to `sales`, `shared` exists in both (ambiguous). */
const REGISTRY = {
	data: { customers: {}, shared: {} },
	sales: { orders: {}, shared: {} },
};

function parse(sql) {
	return alasql.parse(sql).statements[0];
}

describe('GHSA-5c29-q62v-jrwf — unqualified SQL table resolution', () => {
	before(() => {
		_setDatabasesLoader(() => REGISTRY);
	});

	after(() => {
		_setDatabasesLoader(null);
	});

	describe('bare references resolve to the owning database', () => {
		it('resolves a bare SELECT target and records it as an affected table', () => {
			const ast = parse('SELECT id FROM customers');
			const bucket = new SqlStatementBucket(ast);

			assert.strictEqual(ast.from[0].databaseid, 'data', 'resolution is written back onto the AST');
			assert.deepStrictEqual(bucket.getSchemas(), ['data']);
			assert.deepStrictEqual(bucket.getTablesBySchemaName('data'), ['customers']);
		});

		it('resolves a bare JOIN target as well as the FROM target', () => {
			const ast = parse('SELECT c.id, o.amount FROM customers AS c INNER JOIN orders AS o ON c.id = o.id');
			const bucket = new SqlStatementBucket(ast);

			assert.strictEqual(ast.from[0].databaseid, 'data');
			assert.strictEqual(ast.joins[0].table.databaseid, 'sales');
			assert.deepStrictEqual(bucket.getSchemas().sort(), ['data', 'sales']);
		});

		it('resolves bare INSERT, UPDATE and DELETE targets', () => {
			const insert = parse("INSERT INTO customers (id) VALUES ('a')");
			new SqlStatementBucket(insert);
			assert.strictEqual(insert.into.databaseid, 'data');

			const update = parse("UPDATE customers SET name = 'x' WHERE id = 'a'");
			new SqlStatementBucket(update);
			assert.strictEqual(update.table.databaseid, 'data');

			const del = parse("DELETE FROM customers WHERE id = 'a'");
			new SqlStatementBucket(del);
			assert.strictEqual(del.table.databaseid, 'data');
		});

		it('leaves an already-qualified reference untouched', () => {
			const ast = parse('SELECT id FROM sales.orders');
			const bucket = new SqlStatementBucket(ast);

			assert.strictEqual(ast.from[0].databaseid, 'sales');
			assert.deepStrictEqual(bucket.getSchemas(), ['sales']);
		});
	});

	describe('unresolvable references stay bare so the caller fails closed', () => {
		it('does not guess a database for a name defined in more than one', () => {
			const ast = parse('SELECT id FROM shared');
			const bucket = new SqlStatementBucket(ast);

			assert.ok(!ast.from[0].databaseid, 'an ambiguous bare name must not be resolved');
			assert.deepStrictEqual(bucket.getSchemas(), [], 'no schema is recorded, so authorization must deny');
		});

		it('does not invent a database for a name no database defines', () => {
			const ast = parse('SELECT id FROM hdb_user');
			const bucket = new SqlStatementBucket(ast);

			assert.ok(!ast.from[0].databaseid);
			assert.deepStrictEqual(bucket.getSchemas(), []);
		});
	});

	describe('statementHasTableTarget distinguishes "no table" from "unresolved table"', () => {
		it('is false for a calc-only SELECT, which legitimately affects no table', () => {
			assert.strictEqual(statementHasTableTarget(parse('SELECT ABS(-12)')), false);
		});

		it('is true for every statement that names a table, resolved or not', () => {
			assert.strictEqual(statementHasTableTarget(parse('SELECT id FROM shared')), true);
			assert.strictEqual(statementHasTableTarget(parse('SELECT id FROM data.customers')), true);
			assert.strictEqual(statementHasTableTarget(parse("INSERT INTO shared (id) VALUES ('a')")), true);
			assert.strictEqual(statementHasTableTarget(parse("UPDATE shared SET a = 1 WHERE id = 'a'")), true);
			assert.strictEqual(statementHasTableTarget(parse("DELETE FROM shared WHERE id = 'a'")), true);
		});

		it('is true when only a JOIN target is unresolvable', () => {
			const ast = parse('SELECT c.id FROM data.customers AS c INNER JOIN shared AS s ON c.id = s.id');
			assert.strictEqual(statementHasTableTarget(ast), true);
		});
	});

	describe('resolution never throws when the database registry is unavailable', () => {
		it('leaves the reference bare instead of propagating a registry failure', () => {
			_setDatabasesLoader(() => {
				throw new Error('databases not loaded on this thread');
			});
			try {
				const ast = parse('SELECT id FROM customers');
				const bucket = new SqlStatementBucket(ast);

				assert.ok(!ast.from[0].databaseid);
				assert.deepStrictEqual(bucket.getSchemas(), [], 'authorization sees no schema and must deny');
			} finally {
				_setDatabasesLoader(() => REGISTRY);
			}
		});
	});
});
