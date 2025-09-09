import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkTableInSchema, createSchema, describeSchema } from '../utils/schema.mjs';
import { testData } from '../config/envConfig.mjs';
import { createTable } from '../utils/table.mjs';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

describe('1. Environment Setup', () => {
	beforeEach(timestamp);

	it(`Create schema ${testData.schema}`, () => {
		return createSchema(testData.schema);
	});

	it('Create schema confirm schema exists', () => {
		return req()
			.send({
				operation: 'describe_all',
			})
			.expect((r) => {
				const keys = Object.keys(r.body);
				assert.notEqual(keys.indexOf(testData.schema), -1, `${testData.schema} was not found`);
				assert.ok(keys.includes(testData.schema), `${testData.schema} was not found`);
			})
			.expect(200);
	});

	it(`Create schema ${testData.schema_dev}`, () => {
		return createSchema(testData.schema_dev);
	});

	it(`Create schema ${testData.schema_call}`, () => {
		return createSchema(testData.schema_call);
	});

	it(`Create schema ${testData.schema_other}`, () => {
		return createSchema(testData.schema_other);
	});

	it(`Create schema ${testData.schema_another}`, () => {
		return createSchema(testData.schema_another);
	});

	it(`Create schema number as string ${testData.schema_number_string}`, () => {
		return createSchema(testData.schema_number_string);
	});

	it(`Create schema number as another string ${testData.schema_number}`, () => {
		return createSchema(testData.schema_number);
	});

	it(`Create schema as number - expect error`, () => {
		return req()
			.send({
				operation: 'create_schema',
				schema: 1123,
			})
			.expect((r) => {
				const body = JSON.stringify(r.body);
				assert.ok(body.includes("'schema' must be a string"), r.text);
			})
			.expect(400);
	});

	it(`Create table ${testData.cust_tb}`, () => {
		return createTable(testData.schema, testData.cust_tb, testData.cust_id);
	});

	it('Search by hash empty table', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `select *
                      from ${testData.schema}.${testData.cust_tb}
                      where ${testData.cust_id} = 1`,
			})
			.expect((r) => {
				assert.equal(r.body.length, 0, r.text);
			})
			.expect(200);
	});

	it('Create table confirm table exists', () => {
		return checkTableInSchema(testData.schema, testData.cust_tb);
	});

	it(`Create table ${testData.supp_tb}`, () => {
		return createTable(testData.schema, testData.supp_tb, testData.supp_id);
	});

	it(`Create table ${testData.regi_tb}`, () => {
		return createTable(testData.schema, testData.regi_tb, testData.regi_id);
	});

	it(`Create table ${testData.emps_tb}`, () => {
		return createTable(testData.schema, testData.emps_tb, testData.emps_id);
	});

	it(`Create table ${testData.ords_tb}`, () => {
		return createTable(testData.schema, testData.ords_tb, testData.ords_id);
	});

	it(`Create table ${testData.terr_tb}`, () => {
		return createTable(testData.schema, testData.terr_tb, testData.terr_id);
	});

	it(`Create table ${testData.cate_tb}`, () => {
		return createTable(testData.schema, testData.cate_tb, testData.cate_id);
	});

	it(`Create table ${testData.ship_tb}`, () => {
		return createTable(testData.schema, testData.ship_tb, testData.ship_id);
	});

	it(`Create table ${testData.empt_tb}`, () => {
		return createTable(testData.schema, testData.empt_tb, testData.empt_id);
	});

	it(`Create table ${testData.ordd_tb}`, () => {
		return createTable(testData.schema, testData.ordd_tb, 'orderdetailid');
	});

	it(`Create table ${testData.prod_tb}`, () => {
		return createTable(testData.schema, testData.prod_tb, testData.prod_id);
	});

	it(`Create table long_text in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'long_text', 'id');
	});

	it(`Create table aggr in ${testData.schema_call}`, () => {
		return createTable(testData.schema_call, 'aggr', 'all');
	});

	it(`Create table AttributeDropTest in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'AttributeDropTest', 'hashid');
	});

	it(`Describe schema ${testData.schema}`, () => {
		return describeSchema(testData.schema);
	});

	it(`Create table invalid_attribute in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'invalid_attribute', 'id');
	});

	it(`Create table remarks_blob in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'remarks_blob', 'id');
	});

	it(`Create table books in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'books', 'id');
	});

	it(`Create table ratings in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'ratings', 'id');
	});

	it(`Create table time_functions in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'time_functions', 'id');
	});

	it(`Create table dog in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'dog', 'id');
	});

	it(`Create table breed in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'breed', 'id');
	});

	it(`Create table owner in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'owner', 'id');
	});

	it(`Create table movie in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'movie', 'id');
	});

	it(`Create table credits in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'credits', 'movie_id');
	});

	it(`Create table rando in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'rando', 'id');
	});

	it(`Create table owner in ${testData.schema_other}`, () => {
		return createTable(testData.schema_other, 'owner', 'id');
	});

	it(`Create table breed in ${testData.schema_another}`, () => {
		return createTable(testData.schema_another, 'breed', 'id');
	});

	it(`Create table sql_function in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'sql_function', 'id');
	});

	it(`Create table leading_zero in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'leading_zero', 'id');
	});

	it(`Create table number "4" in ${testData.schema_number_string}`, () => {
		return createTable(testData.schema_number_string, '4', 'id');
	});

	it(`Create table number 1 as string in ${testData.schema_number}`, () => {
		return createTable(testData.schema_number, '1', 'id');
	});

	it(`Create table as number - expect error`, () => {
		return req()
			.send({
				operation: 'create_table',
				database: 1123,
				table: 1,
				hash_attribute: 'id',
			})
			.expect((r) => {
				const body = JSON.stringify(r.body);
				assert.ok(body.includes("'schema' must be a string. 'table' must be a string"), r.text);
			})
			.expect(400);
	});

	it('Describe schema ${testData.schema_number_string}', () => {
		return req()
			.send({
				operation: 'describe_schema',
				schema: testData.schema_number_string,
			})
			.expect((r) => {
				assert.ok(r.body.hasOwnProperty('4'), r.text);
				assert.equal(r.body['4'].schema, testData.schema_number_string, r.text);
				assert.equal(r.body['4'].name, '4', r.text);
			})
			.expect(200);
	});

	it('Describe table number "4"', () => {
		return req()
			.send({
				operation: 'describe_table',
				schema: testData.schema_number_string,
				table: '4',
			})
			.expect((r) => {
				assert.equal(r.body.schema, testData.schema_number_string, r.text);
				assert.equal(r.body.name, '4', r.text);
			})
			.expect(200);
	});

	it(`Create table dog_conditions for conditions tests in ${testData.schema_dev}`, () => {
		return createTable(testData.schema_dev, 'dog_conditions', 'id');
	});
});
