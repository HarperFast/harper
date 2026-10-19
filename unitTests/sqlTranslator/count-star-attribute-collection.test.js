'use strict';
/**
 * `COUNT(*)` counts rows and references no attribute, so the statement bucket must not record `*`
 * as one — checkAttributePerms refuses it for any role with a non-empty attribute_permissions list.
 * End-to-end role behavior: integrationTests/security/sql-count-star-attribute-roles.test.ts.
 */

const assert = require('assert');
const alasql = require('alasql');

const SqlStatementBucket = require('#src/sqlTranslator/sql_statement_bucket').default;

const attrs = (sql) =>
	new SqlStatementBucket(alasql.parse(sql).statements[0]).getAttributesBySchemaTableName('data', 'T');

describe('SqlStatementBucket attribute collection for COUNT(*)', () => {
	it('records no attribute for a plain COUNT(*) but keeps the table', () => {
		assert.deepStrictEqual(attrs('SELECT COUNT(*) AS c FROM data.T'), []);
		assert.deepStrictEqual(attrs('SELECT count(*) FROM data.T'), []);
		assert.deepStrictEqual(attrs('SELECT COUNT(T.*) FROM data.T'), []);
	});

	it('skips the wildcard in every clause that can hold an aggregate', () => {
		assert.deepStrictEqual(attrs('SELECT COUNT(*) AS c FROM data.T GROUP BY dept HAVING COUNT(*) > 1'), ['dept']);
		assert.deepStrictEqual(attrs('SELECT 1 AS one FROM data.T ORDER BY COUNT(*)'), []);
		assert.deepStrictEqual(attrs('SELECT id FROM data.T WHERE id IN (SELECT COUNT(*) FROM data.T)'), ['id']);
	});

	it('still records the real columns around the count', () => {
		assert.deepStrictEqual(attrs('SELECT COUNT(*) AS c FROM data.T GROUP BY salary'), ['salary']);
		assert.deepStrictEqual(attrs('SELECT dept, COUNT(*) AS c FROM data.T WHERE age > 1 GROUP BY dept').sort(), [
			'age',
			'dept',
		]);
		assert.deepStrictEqual(
			attrs('SELECT COUNT(*) AS c FROM data.T GROUP BY dept HAVING COUNT(*) > 1 ORDER BY dept').sort(),
			['dept']
		);
	});

	it('keeps recording other aggregate arguments', () => {
		assert.deepStrictEqual(attrs('SELECT COUNT(id) FROM data.T'), ['id']);
		assert.deepStrictEqual(attrs('SELECT COUNT(DISTINCT id) FROM data.T'), ['id']);
	});

	it('keeps recording a wildcard that is not a plain COUNT argument', () => {
		assert.deepStrictEqual(attrs('SELECT FIRST(*) FROM data.T'), ['*']);
		assert.deepStrictEqual(attrs('SELECT ARRAY(*) FROM data.T'), ['*']);
		assert.deepStrictEqual(attrs('SELECT COUNT(DISTINCT *) FROM data.T'), ['*']);
		assert.deepStrictEqual(attrs('SELECT * FROM data.T'), ['*']);
	});
});
