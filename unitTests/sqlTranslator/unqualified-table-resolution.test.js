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

	describe('getUnauthorizedTableRefs reports every reference the permission check would miss', () => {
		const unauthorized = (sql) => new SqlStatementBucket(parse(sql)).getUnauthorizedTableRefs();

		it('is empty for a calc-only SELECT, which legitimately affects no table', () => {
			assert.deepStrictEqual(unauthorized('SELECT ABS(-12)'), []);
		});

		it('is empty when every reference resolved and was recorded', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM customers'), []);
			assert.deepStrictEqual(unauthorized('SELECT id FROM data.customers'), []);
			assert.deepStrictEqual(unauthorized("INSERT INTO customers (id) VALUES ('a')"), []);
			assert.deepStrictEqual(unauthorized("UPDATE customers SET name = 'x' WHERE id = 'a'"), []);
			assert.deepStrictEqual(unauthorized("DELETE FROM customers WHERE id = 'a'"), []);
			assert.deepStrictEqual(unauthorized('SELECT c.id FROM customers AS c INNER JOIN orders AS o ON c.id = o.id'), []);
		});

		it('reports an ambiguous bare reference', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM shared'), ['shared']);
		});

		it('reports a bare reference no database defines', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM hdb_user'), ['hdb_user']);
		});

		// The regression the per-reference form exists for: a global "were any schemas recorded?"
		// test passes here on the strength of the table that DID resolve.
		it('reports an unresolvable table even when another table in the same statement resolved', () => {
			const bucket = new SqlStatementBucket(parse('SELECT * FROM data.customers, shared'));
			assert.deepStrictEqual(bucket.getSchemas(), ['data'], 'the resolvable table is still recorded');
			assert.deepStrictEqual(bucket.getUnauthorizedTableRefs(), ['shared']);
		});

		it('reports an unresolvable JOIN target alongside a resolvable FROM target', () => {
			assert.deepStrictEqual(
				unauthorized('SELECT c.id FROM data.customers AS c INNER JOIN shared AS s ON c.id = s.id'),
				['shared']
			);
		});

		it('reports a derived table, whose reach cannot be determined', () => {
			assert.deepStrictEqual(unauthorized('SELECT * FROM (SELECT * FROM customers) AS sub'), [
				'subquery in FROM position 1',
			]);
		});

		// AlaSQL puts a derived JOIN's source on `join.select` and leaves `join.table` undefined, so
		// a guard keyed on join.table drops it from the inventory entirely.
		it('reports a derived JOIN source, which carries no join.table', () => {
			assert.deepStrictEqual(
				unauthorized('SELECT p.id FROM data.customers AS p INNER JOIN (SELECT * FROM shared) AS s ON p.id = s.id'),
				['subquery in JOIN position 1']
			);
		});

		// A SELECT INTO target is always opaque, never a named reference. As a named reference it
		// would satisfy the membership test against the entry the FROM collector created, so
		// `SELECT * INTO data.customers FROM data.customers` would authorize a write on a read.
		it("reports a SELECT's INTO target, which the affected-attribute map does not model", () => {
			assert.deepStrictEqual(unauthorized('SELECT 1 AS id INTO customers'), ['SELECT INTO target']);
		});

		it('reports a SELECT INTO target that matches the FROM table', () => {
			assert.deepStrictEqual(unauthorized('SELECT * INTO data.customers FROM data.customers'), ['SELECT INTO target']);
		});

		// The attribute collectors never descend into these, so a table reachable only from one of
		// them is invisible to permission checking and must be refused.
		it('reports a WHERE subquery', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM data.customers WHERE id IN (SELECT id FROM shared)'), [
				'nested query in "queries"',
			]);
		});

		it('reports an EXISTS subquery', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM data.customers WHERE EXISTS (SELECT id FROM shared)'), [
				'nested query in "exists"',
			]);
		});

		it('reports a UNION branch', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM data.customers UNION SELECT id FROM shared'), [
				'nested query in "union"',
			]);
		});

		it('reports a UNION ALL branch', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM data.customers UNION ALL SELECT id FROM shared'), [
				'nested query in "unionall"',
			]);
		});

		it("reports an INSERT's source query, whose FROM table is never recorded", () => {
			assert.deepStrictEqual(unauthorized('INSERT INTO data.customers SELECT id FROM shared'), [
				'nested query in "select"',
			]);
		});

		it('does not treat an Object.prototype member as a table', () => {
			assert.deepStrictEqual(unauthorized('SELECT id FROM toString'), ['toString']);
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
