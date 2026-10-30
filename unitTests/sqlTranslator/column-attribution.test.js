'use strict';
/**
 * Every column reference in a SELECT is attributed to the table the SQL engines read it from, so its
 * attribute permission is checked on that table. End-to-end enforcement is covered by
 * integrationTests/security/sql-attribute-perms.test.ts.
 */

const assert = require('assert');
const alasql = require('alasql');

const SqlStatementBucket = require('#src/sqlTranslator/sql_statement_bucket').default;
const { _setDatabasesLoader } = require('#src/sqlEngine/binder/defaultDatabase');

const attributes = (...names) => ({ attributes: names.map((name) => ({ name })) });
const REGISTRY = {
	data: {
		L: { ...attributes('id', 'label', 'ssn'), primaryKey: 'id' },
		R: attributes('id', 'label', 'ssn', 'code'),
		C: attributes('id', 'ssn', 'code'),
		S: attributes('id', 'secret'),
	},
	vault: { L: attributes('id', 'secret') },
};

let registry = REGISTRY;
let registryLoads = 0;

function bucketFor(sql) {
	return new SqlStatementBucket(alasql.parse(sql).statements[0]);
}

function attributesOf(bucket, database, table) {
	return bucket.affected_attributes.get(database).get(table);
}

describe('SQL column attribution for attribute permissions', () => {
	before(() => {
		_setDatabasesLoader(() => {
			registryLoads++;
			return registry;
		});
	});

	beforeEach(() => {
		registry = REGISTRY;
		registryLoads = 0;
	});

	after(() => {
		_setDatabasesLoader(null);
	});

	describe('JOIN USING', () => {
		it('records the column on both joined tables', () => {
			const bucket = bucketFor('SELECT l.label FROM data.L l JOIN data.R r USING (ssn)');
			assert.ok(attributesOf(bucket, 'data', 'L').includes('ssn'));
			assert.ok(attributesOf(bucket, 'data', 'R').includes('ssn'));
		});

		it('records the column on a self-joined table', () => {
			const bucket = bucketFor('SELECT a.label FROM data.L a JOIN data.L b USING (ssn)');
			assert.ok(attributesOf(bucket, 'data', 'L').includes('ssn'));
		});

		it('records only the operands the engine compares: the nearest preceding declarer and the joined table', () => {
			const bucket = bucketFor('SELECT a.id FROM data.L a JOIN data.R b ON a.id = b.id JOIN data.C c USING (ssn)');
			assert.ok(attributesOf(bucket, 'data', 'R').includes('ssn'));
			assert.ok(attributesOf(bucket, 'data', 'C').includes('ssn'));
			assert.ok(!attributesOf(bucket, 'data', 'L').includes('ssn'));
		});

		it('falls back to the FROM table when no preceding table declares the column', () => {
			const bucket = bucketFor('SELECT a.id FROM data.L a JOIN data.C c USING (code)');
			assert.ok(attributesOf(bucket, 'data', 'L').includes('code'));
			assert.ok(attributesOf(bucket, 'data', 'C').includes('code'));
		});
	});

	describe('unqualified columns in a join', () => {
		it('attributes an unqualified ON column to the joined table that declares it', () => {
			const bucket = bucketFor(`SELECT l.label FROM data.L l JOIN data.R r ON l.label = r.label AND code = 'c1'`);
			assert.ok(attributesOf(bucket, 'data', 'R').includes('code'));
			assert.ok(!attributesOf(bucket, 'data', 'L').includes('code'));
		});

		it('resolves an ON column only against the tables joined so far', () => {
			const bucket = bucketFor(
				`SELECT a.id FROM data.L a JOIN data.R b ON a.id = b.id AND code = 'c1' JOIN data.C c ON b.id = c.id`
			);
			assert.ok(attributesOf(bucket, 'data', 'R').includes('code'));
			assert.ok(!attributesOf(bucket, 'data', 'C').includes('code'));
		});

		it('attributes an unqualified select column to its declaring table, including in a comma join', () => {
			for (const sql of ['SELECT code FROM data.L l JOIN data.R r ON l.id = r.id', 'SELECT code FROM data.L, data.R']) {
				const bucket = bucketFor(sql);
				assert.ok(attributesOf(bucket, 'data', 'R').includes('code'), sql);
				assert.ok(!attributesOf(bucket, 'data', 'L').includes('code'), sql);
			}
		});

		it('falls back to a table joined after the ON when none joined so far declares the column', () => {
			const bucket = bucketFor(
				`SELECT a.id FROM data.L a JOIN data.R b ON a.id = b.id AND secret = 'x' JOIN data.S c ON b.id = c.id`
			);
			assert.ok(attributesOf(bucket, 'data', 'S').includes('secret'));
		});

		it('keeps same-named tables in different databases apart', () => {
			const bucket = bucketFor(`SELECT l.label FROM data.L l JOIN vault.L v ON l.id = v.id WHERE secret = 'x'`);
			assert.ok(attributesOf(bucket, 'vault', 'L').includes('secret'));
			assert.ok(!attributesOf(bucket, 'data', 'L').includes('secret'));
		});

		it('records on every candidate table when the registry cannot describe them', () => {
			registry = { data: {} };
			const bucket = bucketFor(
				`SELECT a.id FROM data.L a JOIN data.R b ON a.id = b.id AND code = 'c1' JOIN data.C c USING (ssn)`
			);
			assert.ok(attributesOf(bucket, 'data', 'L').includes('code'));
			assert.ok(attributesOf(bucket, 'data', 'R').includes('code'));
			assert.ok(!attributesOf(bucket, 'data', 'C').includes('code'));
			for (const table of ['L', 'R', 'C']) assert.ok(attributesOf(bucket, 'data', table).includes('ssn'), table);
		});
	});

	describe('qualifiers', () => {
		it('attributes a qualifier to the one table that has it as alias or base name', () => {
			const bucket = bucketFor('SELECT A.ssn FROM data.L a JOIN data.R A ON a.id = A.id');
			assert.ok(attributesOf(bucket, 'data', 'R').includes('ssn'));
			assert.ok(!attributesOf(bucket, 'data', 'L').includes('ssn'));
			assert.deepStrictEqual(bucket.getUnresolvedColumnRefs(), []);
		});

		it("reports a qualifier that is one table's alias and another's base name", () => {
			const bucket = bucketFor('SELECT L.ssn FROM data.L a JOIN data.R L ON a.id = L.id');
			assert.ok(bucket.getUnresolvedColumnRefs().includes('L.ssn'));
			assert.ok(!attributesOf(bucket, 'data', 'R').includes('ssn'));
		});

		it('counts claimants across the whole statement, not just the tables an ON has joined so far', () => {
			const bucket = bucketFor(
				'SELECT a.id FROM data.L a JOIN data.R b ON a.id = b.id AND L.ssn = 1 JOIN data.C L ON b.id = L.id'
			);
			assert.ok(bucket.getUnresolvedColumnRefs().includes('L.ssn'));
		});

		it('reports a qualifier shared by same-named tables in different databases', () => {
			const bucket = bucketFor('SELECT L.secret FROM data.L JOIN vault.L USING (id)');
			assert.deepStrictEqual(bucket.getUnresolvedColumnRefs(), ['L.secret']);
		});

		it('reports a qualifier that names no table in scope', () => {
			const bucket = bucketFor('SELECT bogus.ssn FROM data.L WHERE id = 1');
			assert.deepStrictEqual(bucket.getUnresolvedColumnRefs(), ['bogus.ssn']);
			assert.ok(!attributesOf(bucket, 'data', 'L').includes('ssn'));
		});

		it('reports a base table name that is ambiguous in a self-join', () => {
			const bucket = bucketFor('SELECT L.ssn FROM data.L a JOIN data.L b ON a.id = b.id');
			assert.deepStrictEqual(bucket.getUnresolvedColumnRefs(), ['L.ssn']);
		});

		it('reports a joined SELECT * whose FROM alias another table also claims', () => {
			const bucket = bucketFor('SELECT * FROM data.L JOIN data.R L ON L.id = L.id');
			assert.ok(bucket.getUnresolvedColumnRefs().includes('L.*'));
			assert.ok(!bucketFor('SELECT * FROM data.L l JOIN data.R r ON l.id = r.id').getUnresolvedColumnRefs().length);
		});

		it('reports a write statement column qualified by a name other than its table', () => {
			assert.deepStrictEqual(bucketFor('DELETE FROM data.L WHERE bogus.id IS NULL').getUnresolvedColumnRefs(), [
				'bogus.id',
			]);
			assert.deepStrictEqual(
				bucketFor('UPDATE data.L SET label = bogus.ssn WHERE L.id = 1').getUnresolvedColumnRefs(),
				['bogus.ssn']
			);
		});

		it('accepts a base table name for an aliased single table', () => {
			const bucket = bucketFor('SELECT L.ssn FROM data.L AS l');
			assert.deepStrictEqual(bucket.getUnresolvedColumnRefs(), []);
			assert.ok(attributesOf(bucket, 'data', 'L').includes('ssn'));
		});
	});

	it('records a column nested deeper than 100 levels', () => {
		const nested = 'UPPER('.repeat(80) + 'ssn' + ')'.repeat(80);
		const bucket = bucketFor(`SELECT label FROM data.L WHERE ${nested} = 'X'`);
		assert.ok(attributesOf(bucket, 'data', 'L').includes('ssn'));
	});

	it('treats objects inside a JSON literal as data, but a column inside one as a column', () => {
		const literal = bucketFor(`SELECT {columnid:'id',tableid:'bogus'} AS obj FROM data.L WHERE id = 'x'`);
		assert.deepStrictEqual(literal.getUnresolvedColumnRefs(), []);
		assert.deepStrictEqual(attributesOf(literal, 'data', 'L'), ['id']);
		const update = bucketFor(`UPDATE data.L SET label = {columnid:'ssn'} WHERE id = 1`);
		assert.ok(!attributesOf(update, 'data', 'L').includes('ssn'));
		const nested = bucketFor(`SELECT {a: {columnid:'x', tableid:'zz'}, b: {c: {columnid:'y'}}} AS obj FROM data.L`);
		assert.deepStrictEqual(nested.getUnresolvedColumnRefs(), []);
		assert.ok(!attributesOf(nested, 'data', 'L').includes('y'));
		const wrapped = bucketFor(`SELECT {a: ssn} AS obj FROM data.L WHERE id = 'x'`);
		assert.ok(attributesOf(wrapped, 'data', 'L').includes('ssn'));
	});

	it('does not load the registry for a single-table SELECT', () => {
		const bucket = bucketFor(`SELECT ssn FROM data.L WHERE label = 'x' ORDER BY id`);
		assert.deepStrictEqual(attributesOf(bucket, 'data', 'L').sort(), ['id', 'label', 'ssn']);
		assert.strictEqual(registryLoads, 0);
	});

	describe('reads made by UPDATE and DELETE', () => {
		it('lists WHERE and SET-expression columns, but not the primary key or a SET target', () => {
			const update = bucketFor(`UPDATE data.L SET label = UPPER(ssn) WHERE id = 'x' AND label = 'y'`);
			assert.deepStrictEqual(update.getWriteStatementReads(), {
				schema: 'data',
				table: 'L',
				attributes: ['label', 'ssn'],
			});
			const remove = bucketFor(`DELETE FROM data.L WHERE ssn = '1' OR id = 'x'`);
			assert.deepStrictEqual(remove.getWriteStatementReads().attributes, ['ssn']);
		});

		it('checks SET targets for update but not the columns a SET expression reads', () => {
			const update = bucketFor(`UPDATE data.L SET label = ssn WHERE id = 'x'`);
			assert.deepStrictEqual(attributesOf(update, 'data', 'L'), ['label']);
			assert.deepStrictEqual(update.getWriteStatementReads().attributes, ['ssn']);
			const literal = bucketFor(`UPDATE data.L SET label = {columnid:'ssn'} WHERE id = 'x'`);
			assert.deepStrictEqual(literal.getWriteStatementReads().attributes, []);
		});

		it('lists nothing for a SELECT or INSERT', () => {
			assert.strictEqual(bucketFor('SELECT label FROM data.L').getWriteStatementReads(), undefined);
			assert.strictEqual(bucketFor("INSERT INTO data.L (id) VALUES ('x')").getWriteStatementReads(), undefined);
		});

		it('keeps the primary key when the registry cannot name it', () => {
			registry = { data: {} };
			assert.deepStrictEqual(bucketFor(`DELETE FROM data.L WHERE id = 'x'`).getWriteStatementReads().attributes, [
				'id',
			]);
		});
	});

	describe('row accessors', () => {
		it('lists `_` and JavaScript expressions anywhere in the statement', () => {
			assert.deepStrictEqual(bucketFor('SELECT VALUE FROM data.L').getRowAccessors(), ['_']);
			assert.deepStrictEqual(bucketFor('SELECT label FROM data.L WHERE _->id = 1').getRowAccessors(), ['_']);
			assert.deepStrictEqual(bucketFor('UPDATE data.L SET label = ``1`` WHERE id = 1').getRowAccessors(), [
				'JavaScript expression',
			]);
		});

		it('refuses a JSON literal that hides an expression behind __proto__', () => {
			for (const sql of [
				"SELECT {__proto__:{rec:_}} AS obj FROM data.L WHERE label = 'x'",
				"SELECT {a:{__proto__:{rec:label}}} AS obj FROM data.L WHERE label = 'x'",
			]) {
				assert.ok(bucketFor(sql).getRowAccessors().includes('JSON literal with __proto__'), sql);
			}
		});

		it('finds an accessor nested deeper than 100 levels', () => {
			const nested = 'UPPER('.repeat(80) + '_->id' + ')'.repeat(80);
			assert.deepStrictEqual(bucketFor(`SELECT label FROM data.L WHERE ${nested} = 'X'`).getRowAccessors(), ['_']);
		});

		it('walks a subquery node AlaSQL shares between two fields', () => {
			const bucket = bucketFor('SELECT label FROM data.L WHERE EXISTS (SELECT id FROM data.R)');
			assert.deepStrictEqual(bucket.getRowAccessors(), []);
			// Nested queries are walked with the outer scope, which is safe only because they are refused.
			assert.deepStrictEqual(bucket.getUnauthorizedTableRefs(), ['nested query in "exists"']);
			for (const sql of [
				'SELECT (SELECT ssn FROM data.R) AS s FROM data.L',
				'SELECT label FROM data.L WHERE id IN (SELECT id FROM data.R)',
			]) {
				assert.deepStrictEqual(bucketFor(sql).getUnauthorizedTableRefs(), ['nested query in "queries"'], sql);
			}
		});

		it('lists nothing for a statement that names its columns', () => {
			assert.deepStrictEqual(bucketFor(`SELECT VALUE label FROM data.L WHERE id = 1`).getRowAccessors(), []);
			assert.deepStrictEqual(
				bucketFor("INSERT INTO data.L (id, label) VALUES ('x', {columnid:'_'})").getRowAccessors(),
				[]
			);
		});
	});
});
