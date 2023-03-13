'use strict';
/**
 * Test the sql_statement_bucket module.
 */

const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');
const alasql = require('alasql');
const sql_statement_bucket = require('../../sqlTranslator/sql_statement_bucket');
const sql_statement_rewire = rewire('../../sqlTranslator/sql_statement_bucket');

//DELETE
let TEST_DELETE_JSON = {
	table: {
		databaseid: 'dev',
		tableid: 'dog',
	},
	where: {
		left: {
			left: {
				columnid: 'id',
			},
			op: '=',
			right: {
				value: 1,
			},
		},
		op: 'AND',
		right: {
			left: {
				columnid: 'name',
			},
			op: '=',
			right: {
				value: 'abc',
			},
		},
	},
};
let TEST_DELETE = new alasql.yy.Delete(TEST_DELETE_JSON);

let TEST_INSERT_JSON = {
	into: {
		databaseid: 'dev',
		tableid: 'dog',
	},
	columns: [
		{
			columnid: 'id',
		},
		{
			columnid: 'name',
		},
	],
	values: [
		[
			{
				value: 22,
			},
			{
				value: 'Simon',
			},
		],
	],
};

let TEST_INSERT = new alasql.yy.Insert(TEST_INSERT_JSON);

let TEST_UPDATE_JSON = {
	table: {
		databaseid: 'dev',
		tableid: 'dog',
	},
	columns: [
		{
			column: {
				columnid: 'name',
			},
			expression: {
				value: 'penelope',
			},
		},
	],
	where: {
		left: {
			columnid: 'id',
		},
		op: '=',
		right: {
			value: 1,
		},
	},
};

let TEST_UPDATE = new alasql.yy.Update(TEST_UPDATE_JSON);

let TEST_SELECT_JSON = {
	columns: [
		{
			columnid: '*',
		},
	],
	from: [
		{
			databaseid: 'dev',
			tableid: 'dog',
		},
	],
	where: {
		expression: {
			left: {
				columnid: 'id',
			},
			op: '=',
			right: {
				value: 1,
			},
		},
	},
};

let TEST_SELECT_CROSS_SCHEMA_JOIN_JSON = {
	columns: [
		{
			columnid: 'id',
			tableid: 'd',
		},
		{
			columnid: 'name',
			tableid: 'd',
		},
		{
			columnid: 'breed',
			tableid: 'd',
		},
		{
			columnid: 'owner_name',
			tableid: 'o',
		},
	],
	from: [
		{
			databaseid: 'animals',
			tableid: 'dogs',
			as: 'd',
		},
	],
	joins: [
		{
			joinmode: 'INNER',
			table: {
				databaseid: 'people',
				tableid: 'owners',
			},
			as: 'o',
			on: {
				left: {
					columnid: 'id',
					tableid: 'd',
				},
				op: '=',
				right: {
					columnid: 'id',
					tableid: 'o',
				},
			},
		},
	],
};

//This AST includes a column in the where clause that is not in the SELECT - this is important to test!
let TEST_COMPLEX_AST = {
	columns: [
		{
			columnid: 'id',
			tableid: 'd',
		},
		{
			columnid: 'name',
			tableid: 'd',
		},
		{
			columnid: 'owner_name',
			tableid: 'd',
		},
		{
			columnid: 'name',
			tableid: 'b',
		},
		{
			columnid: 'section',
			tableid: 'b',
		},
	],
	from: [
		{
			databaseid: 'dev',
			tableid: 'dog',
			as: 'd',
		},
	],
	joins: [
		{
			joinmode: 'INNER',
			table: {
				databaseid: 'dev',
				tableid: 'breed',
			},
			as: 'b',
			on: {
				left: {
					columnid: 'breed_id',
					tableid: 'd',
				},
				op: '=',
				right: {
					columnid: 'id',
					tableid: 'b',
				},
			},
		},
	],
	where: {
		expression: {
			left: {
				left: {
					columnid: 'owner_name',
					tableid: 'd',
				},
				op: 'IN',
				right: [
					{
						value: 'Kyle',
					},
					{
						value: 'Zach',
					},
					{
						value: 'Stephen',
					},
				],
			},
			op: 'AND',
			right: {
				left: {
					columnid: 'age',
					tableid: 'b',
				},
				op: '>',
				right: {
					value: 8,
				},
			},
		},
	},
	order: [
		{
			expression: {
				columnid: 'dog_name',
				tableid: 'd',
			},
			direction: 'ASC',
		},
	],
};

let TEST_SELECT = new alasql.yy.Select(TEST_SELECT_JSON);

let SCHEMA_NAME = 'dev';
let TABLE_NAME = 'dog';

let TEST_CROSS_SCHEMA_SELECT = new alasql.yy.Select(TEST_SELECT_CROSS_SCHEMA_JOIN_JSON);
let SCHEMA_NAME_1 = 'animals';
let TABLE_NAME_1 = 'dogs';
let SCHEMA_NAME_2 = 'people';
let TABLE_NAME_2 = 'owners';

/*
    This is a simple, naive clone implementation.  It should never, ever! be used in prod.
 */
function clone(a) {
	return JSON.parse(JSON.stringify(a));
}

let logger_info_spy;

describe('Test sql_statement_bucket Class', () => {
	before(() => {
		const logger_rw = sql_statement_rewire.__get__('harper_logger');
		logger_info_spy = sandbox.spy(logger_rw, 'info');
	});

	after(() => {
		sandbox.restore();
		rewire('../../sqlTranslator/sql_statement_bucket');
	});

	describe(`Test getDeleteAttributes`, function () {
		it('Nominal, pull attributes in delete statement', function () {
			let getDeleteAttributes = sql_statement_rewire.__get__('getDeleteAttributes');
			//let statement = new sql_statement_bucket(TEST_DELETE);
			let statement = new Map();
			let table_lookup = new Map();
			getDeleteAttributes(TEST_DELETE, statement, table_lookup);
			assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 2);
			assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
			assert.equal(Array.from(statement.keys()).length, 1);
		});
		it('Pull attributes from delete statement with no where clause', function () {
			let getDeleteAttributes = sql_statement_rewire.__get__('getDeleteAttributes');
			let copy = clone(TEST_DELETE_JSON);
			copy.where = {};
			let temp_delete = new alasql.yy.Delete(copy);
			let statement = new Map();
			let table_lookup = new Map();
			getDeleteAttributes(temp_delete, statement, table_lookup);
			assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 0);
			assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
			assert.equal(Array.from(statement.keys()).length, 1);
		});
		it('Pull attributes from delete statement with no table clause', function () {
			let getDeleteAttributes = sql_statement_rewire.__get__('getDeleteAttributes');
			let copy = clone(TEST_DELETE_JSON);
			copy.table = {};
			let temp_delete = new alasql.yy.Delete(copy);
			let statement = new Map();
			let table_lookup = new Map();
			getDeleteAttributes(temp_delete, statement, table_lookup);
			// No table was defined, so the returned value should be empty
			assert.equal(statement.get(SCHEMA_NAME), undefined);
		});
	});

	describe(`Test getInsertAttributes`, function () {
		it('Nominal, pull attributes in Insert statement', function () {
			let getInsertAttributes = sql_statement_rewire.__get__('getInsertAttributes');
			//let statement = new sql_statement_bucket(TEST_DELETE);
			let statement = new Map();
			let table_lookup = new Map();
			getInsertAttributes(TEST_INSERT, statement, table_lookup);
			assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 2);
			assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
			assert.equal(Array.from(statement.keys()).length, 1);
		});
		it('Pull attributes from insert statement with no table clause', function () {
			let getInsertAttributes = sql_statement_rewire.__get__('getInsertAttributes');
			let copy = clone(TEST_DELETE_JSON);
			copy.into = {};
			let temp_delete = new alasql.yy.Insert(copy);
			let statement = new Map();
			let table_lookup = new Map();
			getInsertAttributes(temp_delete, statement, table_lookup);
			// No into was defined, so the returned value should be empty
			assert.equal(statement.get(SCHEMA_NAME), undefined);
		});
	});

	describe(`Test getUpdateAttributes`, function () {
		it('Nominal, pull attributes in update statement', function () {
			let getUpdateAttributes = sql_statement_rewire.__get__('getUpdateAttributes');
			let statement = new Map();
			let table_lookup = new Map();
			getUpdateAttributes(TEST_UPDATE, statement, table_lookup);
			assert.equal(statement.get(SCHEMA_NAME).get(TABLE_NAME).length, 1);
			assert.equal(Array.from(statement.get(SCHEMA_NAME).keys()).length, 1);
			assert.equal(Array.from(statement.keys()).length, 1);
		});
		it('Pull attributes from update statement with no table clause', function () {
			let getUpdateAttributes = sql_statement_rewire.__get__('getUpdateAttributes');
			let copy = clone(TEST_UPDATE_JSON);
			copy.table = {};
			let temp_update = new alasql.yy.Update(copy);
			let statement = new Map();
			let table_lookup = new Map();
			getUpdateAttributes(temp_update, statement, table_lookup);
			// No table was defined, so the returned value should be empty
			assert.equal(statement.get(SCHEMA_NAME), undefined);
		});
	});

	describe(`Test getSelectAttributes`, function () {
		it('Nominal, pull attributes in Select statement', function () {
			let getSelectAttributes = sql_statement_rewire.__get__('getSelectAttributes');
			let affected_attrs = new Map();
			let table_lookup = new Map();
			let schema_lookup = new Map();
			getSelectAttributes(TEST_SELECT, affected_attrs, table_lookup, schema_lookup);
			assert.equal(affected_attrs.get(SCHEMA_NAME).get(TABLE_NAME).length, 2);
			assert.equal(Array.from(affected_attrs.get(SCHEMA_NAME).keys()).length, 1);
			assert.equal(Array.from(affected_attrs.keys()).length, 1);
		});

		it('Nominal, pull attributes in Select statement with cross schema join', function () {
			let getSelectAttributes = sql_statement_rewire.__get__('getSelectAttributes');
			let affected_attrs = new Map();
			let table_lookup = new Map();
			let schema_lookup = new Map();
			let table_to_schema_lookup = new Map();
			getSelectAttributes(
				TEST_CROSS_SCHEMA_SELECT,
				affected_attrs,
				table_lookup,
				schema_lookup,
				table_to_schema_lookup
			);
			assert.equal(affected_attrs.get(SCHEMA_NAME_1).get(TABLE_NAME_1).length, 3);
			assert.equal(Array.from(affected_attrs.get(SCHEMA_NAME_1).keys()).length, 1);
			assert.equal(affected_attrs.get(SCHEMA_NAME_2).get(TABLE_NAME_2).length, 2);
			assert.equal(Array.from(affected_attrs.get(SCHEMA_NAME_2).keys()).length, 1);
			assert.equal(Array.from(affected_attrs.keys()).length, 2);
		});

		it('Pull attributes from insert statement with no table clause', function () {
			let getSelectAttributes = sql_statement_rewire.__get__('getSelectAttributes');
			let copy = clone(TEST_UPDATE_JSON);
			copy.from = {};
			let temp_update = new alasql.yy.Select(copy);
			let statement = new Map();
			let table_lookup = new Map();
			let schema_lookup = new Map();
			getSelectAttributes(temp_update, statement, table_lookup, schema_lookup);
			// No table was defined, so the returned value should be empty
			assert.equal(statement.get(SCHEMA_NAME), undefined);
		});
	});

	describe(`Test getRecordAttributesAST`, function () {
		beforeEach(function () {
			sandbox.resetHistory();
		});

		it('Nominal case, valid, reasonably complex AST with attributes. ', function () {
			let getRecordAttributesAST = sql_statement_rewire.__get__('getRecordAttributesAST');
			let test_copy = clone(TEST_COMPLEX_AST);
			let temp_select = new alasql.yy.Select(test_copy);
			let affected_attributes = new Map();
			let table_lookup = new Map();
			let schema_lookup = new Map();
			let table_to_schema_lookup = new Map();
			getRecordAttributesAST(temp_select, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
			let all_tables = new Map();
			let lookups = new Map();
			let attributes = new Map();
			let schema = test_copy.from[0].databaseid;
			test_copy.from.forEach((table) => {
				if (!all_tables.has(table.tableid)) {
					all_tables.set(table.tableid, null);
				}
				if (table.as) {
					if (!lookups.has(table.as)) {
						lookups.set(table.as, table.tableid);
					}
				}
			});
			test_copy.joins.forEach((join) => {
				if (!all_tables.has(join.table.tableid)) {
					all_tables.set(join.table.tableid, null);
				}
				if (join.table.as) {
					if (!lookups.has(join.table.as)) {
						lookups.set(join.table.as, join.table.tableid);
					}
				}
				const l_table_name = lookups.get(join.on.left.tableid);
				const r_table_name = lookups.get(join.on.right.tableid);
				if (attributes.has(l_table_name)) {
					attributes.get(l_table_name).push(join.on.left.columnid);
				} else {
					attributes.set(l_table_name, [join.on.left.columnid]);
				}
				if (attributes.has(r_table_name)) {
					attributes.get(r_table_name).push(join.on.right.columnid);
				} else {
					attributes.set(r_table_name, [join.on.right.columnid]);
				}
			});
			test_copy.columns.forEach((col) => {
				let table_name = col.tableid;
				if (lookups.has(col.tableid)) {
					table_name = lookups.get(table_name);
				}
				//Keeping this more simple than the function in operation_auth.  We are always dealing with the same schema
				// in this test, so limiting this to a [table, [attributes]] map.
				if (attributes.has(table_name)) {
					if (attributes.get(table_name).indexOf(col.columnid) < 0) {
						attributes.get(table_name).push(col.columnid);
					}
				} else {
					attributes.set(table_name, [col.columnid]);
				}
			});
			Object.keys(test_copy.where.expression).forEach((key) => {
				if (key === 'op') {
					return;
				}
				let col = test_copy.where.expression[key].left;
				let table_name = col.tableid;
				if (lookups.has(col.tableid)) {
					table_name = lookups.get(table_name);
				}
				if (!attributes.has(table_name)) {
					attributes.set(table_name, [col.columnid]);
				} else if (attributes.get(table_name).indexOf(col.columnid) < 0) {
					attributes.get(table_name).push(col.columnid);
				}
			});

			test_copy.order.forEach((ob_obj) => {
				let col = ob_obj.expression;
				let table_name = col.tableid;
				if (lookups.has(table_name)) {
					table_name = lookups.get(table_name);
				}

				attributes.get(table_name).push(col.columnid);
			});

			// assert all aliases are accounted for in table lookup
			lookups.forEach(function (value, key) {
				assert.equal(table_lookup.has(key), true, `table_lookup does not have key ${key}`);
			});
			//assert all columns are accounted for
			attributes.forEach(function (value, key, obj) {
				// assert all tables are accounted for
				assert.equal(affected_attributes.get(schema).has(key), true, `attributes does not contain key ${key}`);
				assert.equal(
					value.length,
					affected_attributes.get(schema).get(key).length,
					`expected attribute length ${value.length}, actual: ${affected_attributes.get(schema).get(key).length}`
				);
			});
		});

		it('Nominal case, valid AST with CROSS SCHEMA JOIN ', function () {
			let getRecordAttributesAST = sql_statement_rewire.__get__('getRecordAttributesAST');
			let test_copy = clone(TEST_CROSS_SCHEMA_SELECT);
			let temp_select = new alasql.yy.Select(test_copy);
			let affected_attributes = new Map();
			let table_lookup = new Map();
			let schema_lookup = new Map();
			let table_to_schema_lookup = new Map();
			getRecordAttributesAST(temp_select, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
			let all_tables = new Map();
			let lookups = new Map();
			let attributes = new Map();
			let schemas = {
				[test_copy.from[0].tableid]: test_copy.from[0].databaseid,
				[test_copy.joins[0].table.tableid]: test_copy.joins[0].table.databaseid,
			};
			test_copy.from.forEach((table) => {
				if (!all_tables.has(table.tableid)) {
					all_tables.set(table.tableid, null);
				}
				if (table.as) {
					if (!lookups.has(table.as)) {
						lookups.set(table.as, table.tableid);
					}
				}
			});
			test_copy.joins.forEach((join) => {
				if (!all_tables.has(join.table.tableid)) {
					all_tables.set(join.table.tableid, null);
				}
				if (join.table.as) {
					if (!lookups.has(join.table.as)) {
						lookups.set(join.table.as, join.table.tableid);
					}
				}
				const l_table_name = lookups.get(join.on.left.tableid);
				const r_table_name = lookups.get(join.on.right.tableid);
				if (attributes.has(l_table_name)) {
					attributes.get(l_table_name).push(join.on.left.columnid);
				} else {
					attributes.set(l_table_name, [join.on.left.columnid]);
				}
				if (attributes.has(r_table_name)) {
					attributes.get(r_table_name).push(join.on.right.columnid);
				} else {
					attributes.set(r_table_name, [join.on.right.columnid]);
				}
			});
			test_copy.columns.forEach((col) => {
				let table_name = col.tableid;
				if (lookups.has(col.tableid)) {
					table_name = lookups.get(table_name);
				}
				//Keeping this more simple than the function in operation_auth.  We are always dealing with the same schema
				// in this test, so limiting this to a [table, [attributes]] map.
				if (attributes.has(table_name)) {
					if (attributes.get(table_name).indexOf(col.columnid) < 0) {
						attributes.get(table_name).push(col.columnid);
					}
				} else {
					attributes.set(table_name, [col.columnid]);
				}
			});

			// assert all aliases are accounted for in table lookup
			lookups.forEach(function (value, key) {
				assert.equal(table_lookup.has(key), true, `table_lookup does not have key ${key}`);
			});
			//assert all columns are accounted for
			attributes.forEach(function (value, key, obj) {
				// assert all tables are accounted for
				assert.equal(affected_attributes.get(schemas[key]).has(key), true, `attributes does not contain key ${key}`);
				assert.equal(
					value.length,
					affected_attributes.get(schemas[key]).get(key).length,
					`expected attribute length ${value.length}, actual: ${affected_attributes.get(schemas[key]).get(key).length}`
				);
			});
		});

		it('Nominal case, INVALID table in WHERE, reasonably complex AST with attributes. ', function () {
			let getRecordAttributesAST = sql_statement_rewire.__get__('getRecordAttributesAST');
			let test_copy = clone(TEST_COMPLEX_AST);
			const invalid_table = 'steffen';
			test_copy.where.expression.left.left.tableid = invalid_table;
			let temp_select = new alasql.yy.Select(test_copy);
			let affected_attributes = new Map();
			let table_lookup = new Map();
			let schema_lookup = new Map();
			let table_to_schema_lookup = new Map();
			getRecordAttributesAST(temp_select, affected_attributes, table_lookup, schema_lookup, table_to_schema_lookup);
			assert.equal(logger_info_spy.calledOnce, true, 'invalid table was not logged');
			assert.equal(
				logger_info_spy.args[0],
				`table specified as ${invalid_table} not found.`,
				'invalid table was not logged'
			);
		});
	});

	describe(`Test getAttributesBySchemaTableName`, function () {
		it('Nominal, get attributes expected from select parsing', function () {
			let statement = new sql_statement_bucket(TEST_SELECT);
			assert.equal(statement.getSchemas().length, 1);
		});
	});

	describe(`Test getAllTables`, function () {
		it('Nominal, get all tables expected from select parsing', function () {
			let statement = new sql_statement_bucket(TEST_SELECT);
			assert.equal(statement.getAllTables().length, 1);
		});
	});

	describe(`Test getAllTables`, function () {
		it('Nominal, get all tables expected from select parsing', function () {
			let statement = new sql_statement_bucket(TEST_SELECT);
			assert.equal(statement.getTablesBySchemaName(SCHEMA_NAME).length, 1);
		});
	});
});
