'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const sql_test_utils = require('../sqlTestUtils');
const { createMockDB, tearDownMockDB, deepClone, mochaAsyncWrapper, sortAsc, sortDesc } = test_utils;
const { setupCSVSqlData, generateMockAST, cleanupCSVData, sqlIntegrationData } = sql_test_utils;

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const fs = require('fs-extra');
const path = require('path');
const Papa = require('papaparse');
const SQLSearch = require('../../dataLayer/SQLSearch');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge');
const log = require('../../utility/logging/harper_logger');
const hdb_utils = require('../../utility/common_utils');

const { TEST_DATA_AGGR, TEST_DATA_CAT, TEST_DATA_DOG, TEST_DATA_LONGTEXT } = require('../test_data');

const TEST_SCHEMA = 'dev';
const TEST_SCHEMA_NORTHWND = 'northwnd';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_DOG = 'dog';
const TEST_TABLE_LONGTEXT = 'longtext';
const dog_schema_table_id = (as_val) => `${TEST_SCHEMA}_${as_val ? as_val : TEST_TABLE_DOG}`;
const cat_schema_table_id = (as_val) => `${TEST_SCHEMA}_${as_val ? as_val : TEST_TABLE_CAT}`;
const longtext_schema_table_id = (as_val) => `${TEST_SCHEMA}_${as_val ? as_val : TEST_TABLE_LONGTEXT}`;

const sql_basic_dog_select = `SELECT * FROM ${TEST_SCHEMA}.${TEST_TABLE_DOG}`;
const sql_basic_cat_select = `SELECT * FROM ${TEST_SCHEMA}.${TEST_TABLE_CAT}`;
const sql_basic_calc = '2 * 4';
const sql_basic_calc_result = eval(sql_basic_calc);
const sql_basic_op = `SELECT ${sql_basic_calc}`;
const sql_where_in_ids = [1, 2, 3];

let test_instance;

let sandbox;
let _getColumns_spy;
let _findColumn_spy;
let _getTables_spy;
let _conditionsToFetchAttributeValues_spy;
let backtickASTSchemaItems_spy;
let _getFetchAttributeValues_spy;
let _simpleSQLQuery_spy;
let _getDataByValue_spy;
let _getDataByHash_spy;
let _getFinalAttributeData_spy;
let _getData_spy;
let _finalSQL_spy;
let _buildSQL_spy;
let error_logger_spy;

let test_env = [];

function setClassMethodSpies() {
	sandbox = sinon.createSandbox();
	_getColumns_spy = sandbox.spy(SQLSearch.prototype, '_getColumns');
	_findColumn_spy = sandbox.spy(SQLSearch.prototype, '_findColumn');
	_getTables_spy = sandbox.spy(SQLSearch.prototype, '_getTables');
	_conditionsToFetchAttributeValues_spy = sandbox.spy(SQLSearch.prototype, '_conditionsToFetchAttributeValues');
	_getFetchAttributeValues_spy = sandbox.spy(SQLSearch.prototype, '_getFetchAttributeValues');
	_simpleSQLQuery_spy = sandbox.spy(SQLSearch.prototype, '_simpleSQLQuery');
	_getDataByValue_spy = sandbox.spy(harperBridge, 'getDataByValue');
	_getDataByHash_spy = sandbox.spy(harperBridge, 'getDataByHash');
	_getFinalAttributeData_spy = sandbox.stub(SQLSearch.prototype, '_getFinalAttributeData').callThrough();
	_getData_spy = sandbox.stub(SQLSearch.prototype, '_getData').callThrough();
	_finalSQL_spy = sandbox.spy(SQLSearch.prototype, '_finalSQL');
	_buildSQL_spy = sandbox.spy(SQLSearch.prototype, '_buildSQL');
	backtickASTSchemaItems_spy = sandbox.spy(hdb_utils, 'backtickASTSchemaItems');
	error_logger_spy = sandbox.spy(log, 'error');
}

async function setupBasicTestData() {
	const test_data_dog = deepClone(TEST_DATA_DOG);
	const test_data_cat = deepClone(TEST_DATA_CAT);
	test_data_cat[0]['null_attr'] = null;

	test_env.push(...(await createMockDB(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_dog)));
	test_env.push(...(await createMockDB(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_cat)));
	test_env.push(
		...(await createMockDB(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_LONGTEXT, deepClone(TEST_DATA_LONGTEXT)))
	);
	test_env.push(...(await createMockDB('all', 'call', 'aggr', deepClone(TEST_DATA_AGGR))));
}

function setupTestInstance(sql_statement, set_null_attr) {
	const statement = sql_statement ? sql_statement : sql_basic_dog_select;
	const test_sql = generateMockAST(statement);
	const test_statement = test_sql.statement;
	const test_attributes = set_null_attr === true ? null : test_sql.attributes;
	test_instance = new SQLSearch(test_statement, test_attributes);
}

// Used to sort the row-level attributes within the objects in an array to easily do deep equal evaluations
function sortTestRows(test_results) {
	return test_results.map((row) => {
		const new_row = {};
		const sorted_keys = sortAsc(Object.keys(row));
		sorted_keys.forEach((key) => {
			new_row[key] = row[key];
		});
		return new_row;
	});
}

describe('Test SQL Engine', function () {
	this.timeout(0);

	before(async function () {
		await setupBasicTestData();
		setClassMethodSpies();
	});

	afterEach(function () {
		test_instance = null;
		sandbox.resetHistory();
	});

	after(async function () {
		sandbox.restore();
		await tearDownMockDB(test_env, true);
		await cleanupCSVData();
	});

	describe('constructor()', function () {
		it('should call four class methods when instantiated', function () {
			setupTestInstance();
			expect(_getColumns_spy.calledOnce).to.equal(true);
			expect(_getTables_spy.calledOnce).to.equal(true);
			expect(_conditionsToFetchAttributeValues_spy.calledOnce).to.equal(true);
			expect(backtickASTSchemaItems_spy.calledOnce).to.equal(true);
		});

		it('should throw an exception if no statement argument is provided', function () {
			let err;
			try {
				new SQLSearch(null);
			} catch (e) {
				err = e;
			}
			expect(err).to.equal('statement cannot be null');
		});
	});

	describe('search()', function () {
		it(
			'test function call with alias in select with no from',
			mochaAsyncWrapper(async function () {
				const test_sql_statement = `SELECT DATE_ADD(1111111111, 1, 'days') as col`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results).to.deep.equal([{ col: 1197511111 }]);
			})
		);

		it(
			'test function call with no alias in select with no from',
			mochaAsyncWrapper(async function () {
				const test_sql_statement = `SELECT DATE_ADD(1111111111, 1, 'days')`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results).to.deep.equal([{ "DATE_ADD(1111111111,1,'days')": 1197511111 }]);
			})
		);

		it(
			'test select with function that has single quotes with no alias',
			mochaAsyncWrapper(async function () {
				const test_row = TEST_DATA_DOG[2];
				const test_sql_statement = `SELECT DATE_ADD(id, 1, 'days') FROM dev.dog WHERE id = ${test_row.id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results[0]).to.deep.equal({ 'DATE_ADD(id,1,"days")': 86400003 });
			})
		);

		it(
			'test select with function that has single quotes with alias',
			mochaAsyncWrapper(async function () {
				const test_row = TEST_DATA_DOG[2];
				const test_sql_statement = `SELECT DATE_ADD(id, 1, 'days') as col1 FROM dev.dog WHERE id = ${test_row.id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results[0]).to.deep.equal({ col1: 86400003 });
			})
		);

		it(
			'should return all rows when there is no WHERE clause',
			mochaAsyncWrapper(async function () {
				setupTestInstance();

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results).to.deep.equal(TEST_DATA_DOG);
			})
		);

		it(
			'should return matching row based on WHERE clause',
			mochaAsyncWrapper(async function () {
				const test_row = TEST_DATA_DOG[2];
				const test_sql_statement = `SELECT * FROM dev.dog WHERE id = ${test_row.id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results[0]).to.deep.equal(test_row);
			})
		);

		it(
			'test a query where the same column has the table name in front and then not, to make sure the sql generates correctly',
			mochaAsyncWrapper(async function () {
				const test_row = { id: 1 };
				const test_sql_statement = `SELECT dog.id FROM dev.dog WHERE id = ${test_row.id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results[0]).to.deep.equal(test_row);
			})
		);

		it(
			'test a query where the same column has the table name in front and then not, to make sure the sql generates correctly #2',
			mochaAsyncWrapper(async function () {
				const test_row = { id: 1 };
				const test_sql_statement = `SELECT id FROM dev.dog WHERE dog.id = ${test_row.id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results[0]).to.deep.equal(test_row);
			})
		);

		it(
			'should return matching rows based on WHERE clause',
			mochaAsyncWrapper(async function () {
				const test_rows = [TEST_DATA_DOG[0], TEST_DATA_DOG[1], TEST_DATA_DOG[2]];
				const test_sql_statement = `SELECT * FROM dev.dog WHERE id <= ${TEST_DATA_DOG[2].id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				const sorted_results = sortTestRows(search_results);
				expect(sorted_results).to.deep.equal(test_rows);
			})
		);

		it(
			'should return [] if no rows meet WHERE clause',
			mochaAsyncWrapper(async function () {
				const test_incorrect_id = TEST_DATA_DOG.length + 1;
				const test_sql_statement = `SELECT * FROM dev.dog WHERE id = ${test_incorrect_id}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results).to.be.an('array').that.has.lengthOf(0);
			})
		);

		it(
			'should return the result of a operation with only a calculation',
			mochaAsyncWrapper(async function () {
				setupTestInstance(sql_basic_op, null);

				const search_results = await test_instance.search();

				expect(search_results[0]).to.have.property(sql_basic_calc);
				expect(search_results[0][sql_basic_calc]).to.equal(sql_basic_calc_result);
				// Validate that other methods in search() method were not called;
				expect(_getFetchAttributeValues_spy.called).to.equal(false);
				expect(_getDataByValue_spy.called).to.equal(false);
				expect(_getFinalAttributeData_spy.called).to.equal(false);
				expect(_getData_spy.called).to.equal(false);
				expect(_finalSQL_spy.called).to.equal(false);
			})
		);
	});

	// Note: These SELECT statements scenarios were developed from the SQL integration tests scenarios
	describe('search() - testing variety of SQL statements', function () {
		before(async function () {
			await setupCSVSqlData();
		});

		it(
			'Basic select by hash returns requested attribute values for hash',
			mochaAsyncWrapper(async function () {
				const { attrs, data, hash } = sqlIntegrationData.customers;
				const test_row = data[5];
				const test_sql_statement = `SELECT ${attrs.toString()} FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${
					test_row[hash]
				}'`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				Object.keys(search_results[0]).forEach((key) => {
					expect(search_results[0][key]).to.equal(test_row[key]);
				});
			})
		);

		it(
			'Basic select by hash with wildcard returns requested attribute values for matching hashes',
			mochaAsyncWrapper(async function () {
				const { attrs, data, hash } = sqlIntegrationData.customers;
				const test_search_val = 'A';
				const expected_search_results = data.filter((row) => row[hash].startsWith(test_search_val));
				const sorted_attrs = attrs.sort();
				const test_sql_statement = `SELECT ${attrs.toString()} FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} LIKE '${test_search_val}%'`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(expected_search_results.length);
				search_results.forEach((row) => {
					expect(Object.keys(row).sort()).to.deep.equal(sorted_attrs);
				});
			})
		);

		it(
			'Basic select by value returns requested attributes for matching rows',
			mochaAsyncWrapper(async function () {
				const { data, attrs, test_attr } = sqlIntegrationData.customers;
				const test_row = data[5];
				const test_sql_statement = `SELECT ${attrs.toString()} FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${test_attr} = '${
					test_row[test_attr]
				}'`;
				setupTestInstance(test_sql_statement);

				const search_result = await test_instance.search();

				expect(search_result.length).to.equal(1);
				Object.keys(search_result[0]).forEach((key) => {
					expect(search_result[0][key]).to.equal(test_row[key]);
				});
			})
		);

		it(
			'Basic select by value with wildcard returns requested attributes for matching rows',
			mochaAsyncWrapper(async function () {
				const { data } = sqlIntegrationData.customers;
				const test_search_val = 'A';
				const attr_key = 'companyname';
				const expected_search_results = data.filter((row) => row[attr_key].startsWith(test_search_val));
				const test_sql_statement = `SELECT customerid, postalcode, companyname FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${attr_key} LIKE '${test_search_val}%'`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(expected_search_results.length).and.above(0);
				expect(Object.keys(search_results[0]).length).to.equal(3);
			})
		);

		it(
			'should sort employees by hash in asc order',
			mochaAsyncWrapper(async function () {
				const { data, hash } = sqlIntegrationData.employees;
				const sorted_data = sortTestRows(data);
				const sorted_hashes = sortAsc(sorted_data, hash);
				const test_sql_statement = `SELECT ${hash}, * from ${TEST_SCHEMA_NORTHWND}.employees ORDER BY ${hash} ASC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(sortTestRows(search_results)).to.deep.equal(sorted_hashes);
			})
		);

		it(
			'should return results when reserved words are used for schema.table AND are backticked',
			mochaAsyncWrapper(async function () {
				const expected_data = TEST_DATA_AGGR.filter((row) => row.all > 3);
				const expected_results = sortDesc(expected_data, 'all');
				const test_sql_statement =
					'select age AS `alter`, * from `call`.`aggr` as `and` WHERE `all` > 3 ORDER BY `and`.`all` DESC';
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(expected_results.length).and.above(0);
				search_results.forEach((row, i) => {
					expect(row.all).to.equal(expected_results[i].all);
				});
			})
		);

		it(
			'should return dot & double dot attribute values',
			mochaAsyncWrapper(async function () {
				const test_hash_val = 11;
				const expected_result = TEST_DATA_AGGR.filter((row) => row.all === test_hash_val);
				const test_sql_statement = 'select * from `call`.`aggr` where `all` = ' + test_hash_val;
				setupTestInstance(test_sql_statement);

				const search_result = await test_instance.search();

				expect(search_result.length).to.equal(1);
				Object.keys(search_result[0]).forEach((attr) => {
					if (expected_result[0][attr] === undefined) {
						expect(search_result[0][attr]).to.equal(null);
					} else {
						expect(search_result[0][attr]).to.equal(expected_result[0][attr]);
					}
				});
			})
		);

		it(
			'should return orders sorted by orderid in desc order',
			mochaAsyncWrapper(async function () {
				const { data, hash } = sqlIntegrationData.orders;
				const sorted_hashes = sortDesc(data, hash).map((row) => row[hash]);
				const test_sql_statement = `SELECT ${hash}, * from ${TEST_SCHEMA_NORTHWND}.orders ORDER BY ${hash} DESC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				search_results.forEach((row, i) => {
					expect(row[hash]).to.equal(sorted_hashes[i]);
				});
			})
		);

		it(
			'should return orders ordered by attribute not included in select statement',
			mochaAsyncWrapper(async function () {
				const select_attr = 'customerid';
				const { data, hash } = sqlIntegrationData.orders;
				const sorted_hashes = sortDesc(data, hash);
				const test_sql_statement = `SELECT ${select_attr} from ${TEST_SCHEMA_NORTHWND}.orders ORDER BY ${hash} DESC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				search_results.forEach((row, i) => {
					expect(row[select_attr]).to.equal(sorted_hashes[i][select_attr]);
				});
			})
		);

		it(
			'should return orders ordered by attribute not included in select statement - without table alias',
			mochaAsyncWrapper(async function () {
				const select_attr = 'customerid';
				const { data, hash } = sqlIntegrationData.orders;
				const sorted_hashes = sortDesc(data, hash);
				const test_sql_statement = `SELECT orders.${select_attr} from ${TEST_SCHEMA_NORTHWND}.orders AS orders ORDER BY ${hash} DESC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				search_results.forEach((row, i) => {
					expect(row[select_attr]).to.equal(sorted_hashes[i][select_attr]);
				});
			})
		);

		it(
			'should return orders ordered by attribute with inconsistent table alias',
			mochaAsyncWrapper(async function () {
				const select_attr = 'customerid';
				const { data, hash } = sqlIntegrationData.orders;
				const sorted_hashes = sortDesc(data, hash);
				const test_sql_statement = `SELECT ${hash}, orders.${select_attr} from ${TEST_SCHEMA_NORTHWND}.orders AS orders ORDER BY orders.${hash} DESC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				search_results.forEach((row, i) => {
					expect(row[select_attr]).to.equal(sorted_hashes[i][select_attr]);
				});
			})
		);

		it(
			'should return all orders data ordered by attribute with inconsistent table alias',
			mochaAsyncWrapper(async function () {
				const select_attr = 'customerid';
				const { data, hash } = sqlIntegrationData.orders;
				const sorted_hashes = sortDesc(data, hash);
				const test_sql_statement = `SELECT ${hash}, orders.${select_attr}, * from ${TEST_SCHEMA_NORTHWND}.orders AS orders ORDER BY orders.${hash} DESC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();
				const expected_row_length = Object.keys(data[0]).length;
				search_results.forEach((row, i) => {
					expect(Object.keys(row).length).to.equal(expected_row_length);
					expect(row[select_attr]).to.equal(sorted_hashes[i][select_attr]);
				});
			})
		);

		it(
			'should return count of records with attr value equal to null',
			mochaAsyncWrapper(async function () {
				const { data } = sqlIntegrationData.orders;
				const expected_result = data.filter((row) => row.shipregion === null).length;
				const test_sql_statement =
					'SELECT COUNT(*) AS `count` FROM ' + `${TEST_SCHEMA_NORTHWND}.orders WHERE shipregion IS NULL`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results[0].count).to.equal(expected_result);
			})
		);

		it(
			'should return count of records with attr value NOT equal to null',
			mochaAsyncWrapper(async function () {
				const { data } = sqlIntegrationData.orders;
				const expected_result = data.filter((row) => row.shipregion !== null).length;
				const test_sql_statement =
					'SELECT COUNT(*) AS `count` FROM ' + `${TEST_SCHEMA_NORTHWND}.orders WHERE shipregion IS NOT NULL`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results[0].count).to.equal(expected_result);
			})
		);

		it(
			'should return complex join sorted by summed attribute value and joined company name in desc order',
			mochaAsyncWrapper(async function () {
				const { data } = sqlIntegrationData.orderdetails;
				const expected_results_sorted = sortDesc(data, 'unitprice');
				const test_sql_statement = `SELECT a.orderid, a.productid, d.companyname, d.contactmame, b.productname, SUM(a.unitprice) AS unitprice, SUM(a.quantity), SUM(a.discount) FROM ${TEST_SCHEMA_NORTHWND}.orderdetails a JOIN ${TEST_SCHEMA_NORTHWND}.products b ON a.productid = b.productid JOIN ${TEST_SCHEMA_NORTHWND}.orders c ON a.orderid = c.orderid JOIN ${TEST_SCHEMA_NORTHWND}.customers d ON c.customerid = d.customerid GROUP BY a.orderid, a.productid, d.companyname, d.contactmame, b.productname ORDER BY unitprice DESC, d.companyname`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(expected_results_sorted.length);
				expect(search_results[0].unitprice).to.equal(expected_results_sorted[0].unitprice);
				expect(search_results[0].companyname).to.equal('Berglunds snabbk\ufffdp');
				expect(search_results[1].companyname).to.equal('Great Lakes Food Market');
			})
		);

		it(
			'should return requested attributes from 5 table join statement for specified companyname',
			mochaAsyncWrapper(async function () {
				const test_companyname = 'Alfreds Futterkiste';
				const expected_customer_data = sqlIntegrationData.customers.data.filter(
					(row) => row.companyname === test_companyname
				)[0];
				const test_sql_statement = `SELECT a.customerid, a.companyname, a.contactmame, b.orderid, b.shipname, d.productid, d.productname, d.unitprice, c.quantity, c.discount, e.employeeid, e.firstname, e.lastname FROM ${TEST_SCHEMA_NORTHWND}.customers a JOIN ${TEST_SCHEMA_NORTHWND}.orders b ON a.customerid = b.customerid JOIN ${TEST_SCHEMA_NORTHWND}.orderdetails c ON b.orderid = c.orderid JOIN ${TEST_SCHEMA_NORTHWND}.products d ON c.productid = d.productid JOIN ${TEST_SCHEMA_NORTHWND}.employees e ON b.employeeid = e.employeeid WHERE a.companyname = '${test_companyname}'`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(12);
				expect(search_results[0].companyname).to.equal(test_companyname);
				expect(search_results[0].customerid).to.equal(expected_customer_data.customerid);
				expect(search_results[0].contactname).to.equal(expected_customer_data.contactname);
			})
		);

		it(
			'should count customers and group by country attribute',
			mochaAsyncWrapper(async function () {
				const { data } = sqlIntegrationData.customers;
				const expected_results = data.reduce((acc, row) => {
					const { country } = row;
					if (!acc[country]) {
						acc[country] = 1;
					} else {
						acc[country] += 1;
					}
					return acc;
				}, {});
				const test_sql_statement = `SELECT COUNT(customerid) AS counter, country FROM ${TEST_SCHEMA_NORTHWND}.customers GROUP BY country ORDER BY counter DESC`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(Object.keys(expected_results).length);
				search_results.forEach((row) => {
					const { counter, country } = row;
					expect(counter).to.equal(expected_results[country]);
				});
			})
		);

		it(
			'should return the top 10 products by unitprice based on limit and order by',
			mochaAsyncWrapper(async function () {
				const test_limit = 10;
				const test_data = [...sqlIntegrationData.products.data];
				const expected_results = sortDesc(test_data, 'unitprice');
				expected_results.splice(test_limit);
				const test_sql_statement = `SELECT categoryid, productname, quantityperunit, unitprice, * from ${TEST_SCHEMA_NORTHWND}.products ORDER BY unitprice DESC LIMIT ${test_limit}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(test_limit);
				expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
			})
		);

		it(
			'should return the top 10 products by ROUND(unitprice) based on limit and order by',
			mochaAsyncWrapper(async function () {
				const test_limit = 5;
				const test_data = sqlIntegrationData.products.data.slice();
				let expected_results = sortDesc(test_data, 'unitprice');
				expected_results.splice(test_limit);
				expected_results = expected_results.map((row) => {
					return { ...row, u_price: Math.round(row.unitprice) };
				});
				const test_sql_statement = `SELECT categoryid, productname, quantityperunit, ROUND(unitprice) as u_price, * from ${TEST_SCHEMA_NORTHWND}.products ORDER BY u_price DESC LIMIT ${test_limit}`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(test_limit);
				expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
			})
		);

		it(
			'should return count min max avg sum price of products',
			mochaAsyncWrapper(async function () {
				const data = sqlIntegrationData.products.data.slice();
				const expected_results = data.reduce(
					(acc, row) => {
						const { unitprice } = row;
						acc.allproducts += 1;
						acc.sumprice += unitprice;
						acc.avgprice = acc.sumprice / acc.allproducts;
						if (!acc.minprice || unitprice < acc.minprice) {
							acc.minprice = unitprice;
						}
						if (!acc.maxprice || unitprice > acc.maxprice) {
							acc.maxprice = unitprice;
						}
						return acc;
					},
					{ allproducts: 0, minprice: null, maxprice: null, avgprice: 0, sumprice: 0 }
				);
				const test_sql_statement = `SELECT COUNT(unitprice) AS allproducts, MIN(unitprice) AS minprice, MAX(unitprice) AS maxprice, AVG(unitprice) AS avgprice, SUM(unitprice) AS sumprice FROM ${TEST_SCHEMA_NORTHWND}.products`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(1);
				Object.keys(search_results[0]).forEach((val) => {
					expect(search_results[0][val]).to.equal(expected_results[val]);
				});
			})
		);

		it(
			'should return rounded unit price and group by calculated value',
			mochaAsyncWrapper(async function () {
				const test_alias = 'Price';
				const data = sqlIntegrationData.products.data.slice();
				const expected_result = data.reduce((acc, row) => {
					const { unitprice } = row;
					const rounded_val = Math.round(unitprice);
					if (!acc.includes(rounded_val)) {
						acc.push(rounded_val);
					}
					return acc;
				}, []);
				const test_sql_statement = `SELECT ROUND(unitprice) AS ${test_alias} FROM ${TEST_SCHEMA_NORTHWND}.products GROUP BY ROUND(unitprice)`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(expected_result.length);
				search_results.forEach((val) => {
					const price_val = val[test_alias];
					expect(Object.keys(val).length).to.equal(1);
					expect(expected_result.includes(price_val)).to.equal(true);
				});
			})
		);

		it(
			'should return results based on wildcard and min value parameters',
			mochaAsyncWrapper(async function () {
				const test_search_string = 'T';
				const test_search_min = 100;
				const data = sqlIntegrationData.products.data.slice();
				const expected_results = data.filter(
					(row) => row.productname.startsWith(test_search_string) && row.unitprice > test_search_min
				);
				const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.products WHERE (productname LIKE '${test_search_string}%') AND (unitprice > ${test_search_min})`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
			})
		);

		it(
			'should return longtext values based on regex',
			mochaAsyncWrapper(async function () {
				const test_regex = 'dock';
				const expected_results = TEST_DATA_LONGTEXT.filter((row) => row.remarks.includes(test_regex));
				const test_sql_statement = `SELECT * FROM dev.longtext where remarks regexp '${test_regex}'`;
				setupTestInstance(test_sql_statement);

				const search_results = await test_instance.search();

				expect(search_results.length).to.equal(expected_results.length);
				expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
			})
		);
	});

	describe('_checkEmptySQL()', function () {
		it(
			'should return empty array if attributes and columns are set in class instance',
			mochaAsyncWrapper(async function () {
				setupTestInstance();

				const method_results = await test_instance._checkEmptySQL();

				expect(method_results).to.deep.equal([]);
			})
		);

		it(
			'should return the result of a sql operation if sql is only calculation',
			mochaAsyncWrapper(async function () {
				setupTestInstance(sql_basic_op, null);

				const method_results = await test_instance._checkEmptySQL();

				expect(method_results[0]).to.have.property(sql_basic_calc);
				expect(method_results[0][sql_basic_calc]).to.equal(sql_basic_calc_result);
			})
		);
	});

	describe('_getColumns()', function () {
		it('should collect column data from the statement and set it to column property on class', function () {
			const test_sql_statement = 'SELECT * FROM dev.dog';
			setupTestInstance(test_sql_statement);
			test_instance.columns = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._getColumns();

			const { columns } = test_instance.columns;
			const expected_columns = Object.keys(TEST_DATA_DOG[0]);
			expected_columns.push('*');

			expect(columns.length).to.equal(expected_columns.length);
			columns.forEach((col) => {
				expect(expected_columns.includes(col.columnid)).to.equal(true);
				if (col.columnid !== '*') {
					expect(col.tableid).to.equal(TEST_TABLE_DOG);
				}
			});
		});

		it('should collect column data from statement columns, joins, and order by and set to columns property', function () {
			const test_sql_statement =
				'SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY d.id';
			setupTestInstance(test_sql_statement);
			test_instance.columns = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._getColumns();

			const column_data = test_instance.columns;
			const { columns, joins, order } = column_data;
			const expected_columns = { id: 'd', name: 'd', breed: 'd', age: 'c' };

			expect(Object.keys(column_data).length).to.equal(3);
			expect(columns.length).to.equal(4);
			expect(joins.length).to.equal(2);
			expect(order.length).to.equal(1);
			columns.forEach((col) => {
				expect(col.tableid).to.equal(expected_columns[col.columnid]);
			});
			expect(joins[0].columnid).to.equal('id');
			expect(joins[0].tableid).to.equal('d');
			expect(joins[1].columnid).to.equal('id');
			expect(joins[1].tableid).to.equal('c');
			expect(order[0].columnid).to.equal('id');
			expect(order[0].tableid).to.equal('d');
		});

		it('should search for ORDER BY element and replace the column alias with the expression from SELECT', function () {
			const test_sql_statement =
				'SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id';
			setupTestInstance(test_sql_statement);
			test_instance.columns = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._getColumns();

			const { columns } = test_instance.columns;
			expect(columns[0].columnid).to.equal('id');
			expect(columns[0].tableid).to.equal('d');
			expect(columns[0].as).to.equal('id');
			const order_by_expression = test_instance.statement.order[0].expression;
			expect(order_by_expression.columnid).to.equal('id');
			expect(Object.keys(order_by_expression).length).to.equal(1);
		});

		it('test not needing table alias on attributes that are uniquely named between tables', function () {
			const test_sql_statement =
				'SELECT d.id AS id, d.name, breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id';
			setupTestInstance(test_sql_statement);
			test_instance.columns = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._getColumns();

			const { columns } = test_instance.columns;
			expect(columns[0].columnid).to.equal('id');
			expect(columns[0].tableid).to.equal('d');
			expect(columns[0].as).to.equal('id');
			const order_by_expression = test_instance.statement.order[0].expression;
			expect(order_by_expression.columnid).to.equal('id');
			expect(Object.keys(order_by_expression).length).to.equal(1);
		});
	});

	describe('_getTables()', function () {
		function checkTestInstanceData(data, table_id, hash_name, has_hash, merged_data) {
			const test_table_obj = data[table_id];
			const { __hash_name, __merged_data } = test_table_obj;

			const exp_hash_name = hash_name ? hash_name : 'id';
			const exp_merged_data = merged_data ? merged_data : {};

			expect(test_table_obj).to.be.an('object');
			expect(__hash_name).to.equal(exp_hash_name);
			expect(__merged_data).to.deep.equal(exp_merged_data);
		}

		it('test multiple attributes from ONE table sets one table in this.data and gets hash_name from global.schema', function () {
			setupTestInstance();
			test_instance.data = {};
			test_instance.tables = [];

			test_instance._getTables();

			const { data, tables } = test_instance;
			checkTestInstanceData(data, dog_schema_table_id());
			expect(tables[0].databaseid).to.equal(TEST_SCHEMA);
			expect(tables[0].tableid).to.equal(TEST_TABLE_DOG);
		});

		it('test multiple attributes from multiple table sets multiple tables in this.data and gets hash_name from global.schema', function () {
			const test_sql_statement = 'SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id';
			setupTestInstance(test_sql_statement);
			test_instance.data = {};
			test_instance.tables = [];

			test_instance._getTables();

			const { data, tables } = test_instance;
			checkTestInstanceData(data, dog_schema_table_id('d'));
			checkTestInstanceData(data, cat_schema_table_id('c'));
			expect(tables[0].databaseid).to.equal(TEST_SCHEMA);
			expect(tables[0].tableid).to.equal(TEST_TABLE_DOG);
			expect(tables[1].databaseid).to.equal(TEST_SCHEMA);
			expect(tables[1].tableid).to.equal(TEST_TABLE_CAT);
		});
	});

	describe('_conditionsToFetchAttributeValues()', function () {
		const test_attr_path = `${TEST_SCHEMA}/${TEST_TABLE_DOG}/${HASH_ATTRIBUTE}`;

		it('should NOT set exact_search_values property when there is no WHERE clause', function () {
			const test_sql_statement = sql_basic_dog_select;
			setupTestInstance(test_sql_statement);
			test_instance.exact_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.exact_search_values;
			expect(test_result).to.deep.equal({});
		});

		it('should set exact_search_values property with data from WHERE clause', function () {
			const test_hash_val = 1;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} = ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.exact_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.exact_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			test_result[test_attr_path].values.forEach((val) => {
				expect(val).to.equal(test_hash_val);
			});
		});

		it('should perform same as test above but with a test hash value of zero', () => {
			const test_hash_val = 0;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} = ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.exact_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.exact_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			test_result[test_attr_path].values.forEach((val) => {
				expect(val).to.equal(0);
			});
		});

		it('should set multiple values to exact_search_values property with data from WHERE IN clause', function () {
			const test_hash_vals = '1,2';
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} IN (${test_hash_vals})`;
			setupTestInstance(test_sql_statement);
			test_instance.exact_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.exact_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			test_result[test_attr_path].values.forEach((val) => {
				expect([1, 2].includes(val)).to.equal(true);
			});
		});

		it('should set comparator_search_values property with < comparator logic from WHERE clause', function () {
			const test_hash_val = 5;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} < ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			expect(test_result[test_attr_path].comparators[0]).to.deep.equal({
				attribute: HASH_ATTRIBUTE,
				operation: '<',
				search_value: test_hash_val,
			});
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should set comparator_search_values property with <= comparator logic from WHERE clause', function () {
			const test_hash_val = 5;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} <= ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			expect(test_result[test_attr_path].comparators[0]).to.deep.equal({
				attribute: HASH_ATTRIBUTE,
				operation: '<=',
				search_value: test_hash_val,
			});
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should set comparator_search_values property with > comparator logic from WHERE clause', function () {
			const test_hash_val = 5;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} > ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			expect(test_result[test_attr_path].comparators[0]).to.deep.equal({
				attribute: HASH_ATTRIBUTE,
				operation: '>',
				search_value: test_hash_val,
			});
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should set comparator_search_values property with >= comparator logic from WHERE clause', function () {
			const test_hash_val = 5;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} >= ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(test_result[test_attr_path]).to.be.a('object');
			expect(test_result[test_attr_path].ignore).to.equal(false);
			expect(test_result[test_attr_path].comparators[0]).to.deep.equal({
				attribute: HASH_ATTRIBUTE,
				operation: '>=',
				search_value: test_hash_val,
			});
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should not set comparator_search_values if the expression.left is null', function () {
			const test_hash_val = 5;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} >= ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;
			test_instance.statement.where.expression.left = null;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(test_result).to.deep.equal({});
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should not set comparator_search_values if the expression.right is null', function () {
			const test_hash_val = 5;
			const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} >= ${test_hash_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;
			test_instance.statement.where.expression.right = null;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(test_result).to.deep.equal({});
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should set multiple comparator_search_values if the WHERE clause has multiple different attr conditions', function () {
			const age_attr_key = 'age';
			const test_hash_val = 5;
			const test_age_val = 10;
			const test_sql_statement =
				sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} >= ${test_hash_val} AND ${age_attr_key} > ${test_age_val}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values;
			expect(Object.keys(test_result).length).to.equal(2);
			expect(test_instance.exact_search_values).to.deep.equal({});
		});

		it('should set multiple comparator_search_values.comparators values if the WHERE clause has multiple same attr conditions', function () {
			const test_age_key = `dev/dog/age`;
			const age_attr_key = 'age';
			const test_age_val1 = 5;
			const test_age_val2 = 10;
			const test_sql_statement =
				sql_basic_dog_select + ` WHERE ${age_attr_key} >= ${test_age_val1} AND ${age_attr_key} < ${test_age_val2}`;
			setupTestInstance(test_sql_statement);
			test_instance.comparator_search_values = {};
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			test_instance.statement = test_AST_statememt;

			test_instance._conditionsToFetchAttributeValues();

			const test_result = test_instance.comparator_search_values[test_age_key];
			expect(test_result.comparators.length).to.equal(2);
			expect(test_instance.exact_search_values).to.deep.equal({});
		});
	});

	describe('_backtickAllSchemaItems()', function () {
		function backtickString(string_val) {
			return `\`${string_val}\``;
		}

		it('should add backticks to all schema elements in statement property', function () {
			const test_sql_statement =
				'SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id';
			const test_AST_statememt = generateMockAST(test_sql_statement).statement;
			const expected_results = deepClone(test_AST_statememt);
			setupTestInstance(test_sql_statement);
			test_instance.statement = test_AST_statememt;

			hdb_utils.backtickASTSchemaItems(test_instance.statement);

			const test_statement_keys = Object.keys(test_AST_statememt);
			test_statement_keys.forEach((key) => {
				test_instance.statement[key].forEach((item_vals, i) => {
					const initial_val = expected_results[key][i];
					switch (key) {
						case 'columns':
							expect(item_vals.columnid).to.equal(backtickString(initial_val.columnid));
							expect(item_vals.tableid).to.equal(backtickString(initial_val.tableid));
							expect(item_vals.columnid_orig).to.equal(initial_val.columnid);
							expect(item_vals.tableid_orig).to.equal(initial_val.tableid);
							if (initial_val.as) {
								expect(item_vals.as).to.equal(backtickString(initial_val.as));
								expect(item_vals.as_orig).to.equal(initial_val.as);
							}
							break;
						case 'from':
							expect(item_vals.databaseid).to.equal(backtickString(initial_val.databaseid));
							expect(item_vals.tableid).to.equal(backtickString(initial_val.tableid));
							expect(item_vals.databaseid_orig).to.equal(initial_val.databaseid);
							expect(item_vals.tableid_orig).to.equal(initial_val.tableid);
							if (initial_val.as) {
								expect(item_vals.as).to.equal(backtickString(initial_val.as));
								expect(item_vals.as_orig).to.equal(initial_val.as);
							}
							break;
						case 'joins':
							expect(item_vals.on.left.columnid).to.equal(backtickString(initial_val.on.left.columnid));
							expect(item_vals.on.left.tableid).to.equal(backtickString(initial_val.on.left.tableid));
							expect(item_vals.on.right.columnid).to.equal(backtickString(initial_val.on.right.columnid));
							expect(item_vals.on.right.tableid).to.equal(backtickString(initial_val.on.right.tableid));
							expect(item_vals.table.databaseid).to.equal(backtickString(initial_val.table.databaseid));
							expect(item_vals.table.tableid).to.equal(backtickString(initial_val.table.tableid));
							expect(item_vals.on.left.columnid_orig).to.equal(initial_val.on.left.columnid);
							expect(item_vals.on.left.tableid_orig).to.equal(initial_val.on.left.tableid);
							expect(item_vals.on.right.columnid_orig).to.equal(initial_val.on.right.columnid);
							expect(item_vals.on.right.tableid_orig).to.equal(initial_val.on.right.tableid);
							expect(item_vals.table.databaseid_orig).to.equal(initial_val.table.databaseid);
							expect(item_vals.table.tableid_orig).to.equal(initial_val.table.tableid);
							if (initial_val.table.as) {
								expect(item_vals.table.as).to.equal(backtickString(initial_val.table.as));
								expect(item_vals.table.as_orig).to.equal(initial_val.table.as);
							}
							break;
						case 'order':
							expect(item_vals.expression.columnid).to.equal(backtickString(initial_val.expression.columnid));
							expect(item_vals.expression.columnid_orig).to.equal(initial_val.expression.columnid);
							break;
						default:
							break;
					}
				});
			});
		});
	});

	describe('_findColumn()', function () {
		it('should return full column data for requested column', function () {
			const test_column = { columnid: HASH_ATTRIBUTE, tableid: TEST_TABLE_DOG };
			setupTestInstance();

			const test_result = test_instance._findColumn(test_column);

			expect(test_result.attribute).to.equal(test_column.columnid);
			expect(test_result.table.databaseid).to.equal(TEST_SCHEMA);
			expect(test_result.table.tableid).to.equal(test_column.tableid);
		});

		it('should return column data for alias', function () {
			const test_alias = 'dogname';
			const test_sql_statement = `SELECT d.id AS id, d.name AS ${test_alias}, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id`;
			const test_column = { columnid: test_alias };
			setupTestInstance(test_sql_statement);

			const test_result = test_instance._findColumn(test_column);

			expect(test_result.attribute).to.equal('name');
			expect(test_result.table.databaseid).to.equal(TEST_SCHEMA);
			expect(test_result.table.tableid).to.equal(TEST_TABLE_DOG);
		});

		it('should NOT return data for column that does not exist', function () {
			const test_column = { columnid: 'snoopdog' };
			setupTestInstance();

			const test_result = test_instance._findColumn(test_column);

			expect(test_result).to.equal(undefined);
		});
	});

	describe('_addFetchColumns()', function () {
		it('should add columns from JOIN clause to fetch_attributes property', function () {
			const test_sql_statement = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
			setupTestInstance(test_sql_statement);

			test_instance._addFetchColumns(test_instance.columns.joins);

			expect(test_instance.fetch_attributes.length).to.equal(2);
			expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
			expect(test_instance.fetch_attributes[0].table.as).to.equal('d');
			expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
			expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
			expect(test_instance.fetch_attributes[1].attribute).to.equal(HASH_ATTRIBUTE);
			expect(test_instance.fetch_attributes[1].table.as).to.equal('c');
			expect(test_instance.fetch_attributes[1].table.databaseid).to.equal(TEST_SCHEMA);
			expect(test_instance.fetch_attributes[1].table.tableid).to.equal(TEST_TABLE_CAT);
		});

		it('should add columns from ORDER BY clause to fetch_attributes property', function () {
			const test_sql_statement = `${sql_basic_dog_select} ORDER BY id`;
			setupTestInstance(test_sql_statement);

			test_instance._addFetchColumns(test_instance.columns.order);

			expect(test_instance.fetch_attributes.length).to.equal(1);
			expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
			expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
			expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
		});

		it('should add columns from WHERE clause to fetch_attributes property', function () {
			const test_sql_statement = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;
			setupTestInstance(test_sql_statement);

			test_instance._addFetchColumns(test_instance.columns.where);

			expect(test_instance.fetch_attributes.length).to.equal(1);
			expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
			expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
			expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
		});

		it('should NOT add columns to fetch_attributes property if not found', function () {
			const test_sql_statement = `${sql_basic_dog_select}`;
			const test_column = { columnid: 'snoopdog' };
			setupTestInstance(test_sql_statement);

			test_instance._addFetchColumns(test_column);

			expect(test_instance.fetch_attributes.length).to.equal(0);
		});
	});

	describe('_getFetchAttributeValues()', function () {
		it(
			'should call simpleSQLQuery and return results for simple SELECT statement',
			mochaAsyncWrapper(async function () {
				const expected_result = TEST_DATA_DOG;
				const test_sql_basic = sql_basic_dog_select;
				setupTestInstance(test_sql_basic);

				const test_result = await test_instance._getFetchAttributeValues();

				expect(Object.values(test_instance.data[dog_schema_table_id()].__merged_data)).to.deep.equal(expected_result);
				expect(test_result).to.deep.equal(expected_result);
				expect(_getDataByValue_spy.callCount).to.equal(4);
				expect(_simpleSQLQuery_spy.calledOnce).to.equal(true);
			})
		);

		it(
			'should set values to the data[table].__merged_data property for specified hash attributes from WHERE clause',
			mochaAsyncWrapper(async function () {
				const expected_result = TEST_DATA_DOG.reduce((acc, col) => {
					if (col.id < 4) {
						acc.push(col.id);
					}
					return acc;
				}, []);
				const test_sql_where = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;
				setupTestInstance(test_sql_where);

				await test_instance._getFetchAttributeValues();

				const test_data_result = test_instance.data[dog_schema_table_id()].__merged_data;
				expect(test_instance.fetch_attributes.length).to.equal(1);
				expect(Object.values(test_data_result).length).to.equal(expected_result.length);
				Object.keys(test_data_result).forEach((key) => {
					expect(expected_result.includes(test_data_result[key][0])).to.equal(true);
				});
				expect(_getDataByHash_spy.calledOnce).to.equal(true);
				expect(_getDataByValue_spy.calledOnce).to.equal(false);
				expect(_simpleSQLQuery_spy.called).to.equal(false);
			})
		);

		it(
			'should set values to the data[table].__merged_data property for specified attribute value and associated hash key/value pairs from WHERE clause',
			mochaAsyncWrapper(async function () {
				const name_attr_val = 'Sam';
				const attr_data = TEST_DATA_DOG.map((col) => ({ [`${col.id}`]: col.name }));
				const expected_result = attr_data.reduce((acc, val) => {
					const hash_key = Object.keys(val)[0];
					if (val[hash_key] === name_attr_val) {
						acc[hash_key] = [Number(hash_key), val[hash_key]];
					}
					return acc;
				}, {});
				const test_sql_where = `${sql_basic_dog_select} WHERE name = '${name_attr_val}'`;
				setupTestInstance(test_sql_where);

				await test_instance._getFetchAttributeValues();
				const test_data_result = test_instance.data[dog_schema_table_id()].__merged_data;

				expect(Object.values(test_data_result).length).to.equal(Object.values(expected_result).length);
				expect(test_data_result).to.deep.equal(expected_result);
				expect(_getDataByHash_spy.called).to.equal(false);
				expect(_getDataByValue_spy.calledOnce).to.equal(true);
			})
		);

		it(
			'should set values to the data[table].__merged_data property for specified attributes from JOIN clause',
			mochaAsyncWrapper(async function () {
				const expected_result_dog = TEST_DATA_DOG.reduce((acc, col) => {
					acc[col.id] = [col.id];
					return acc;
				}, {});
				const expected_result_cat = TEST_DATA_CAT.reduce((acc, col) => {
					acc[col.id] = [col.id];
					return acc;
				}, {});
				const test_sql_join = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
				setupTestInstance(test_sql_join);

				await test_instance._getFetchAttributeValues();
				const test_data_result_dog = test_instance.data[dog_schema_table_id('d')].__merged_data;
				const test_data_result_cat = test_instance.data[cat_schema_table_id('c')].__merged_data;

				expect(test_instance.fetch_attributes.length).to.equal(2);
				expect(test_data_result_dog).to.deep.equal(expected_result_dog);
				expect(test_data_result_cat).to.deep.equal(expected_result_cat);
				expect(_getDataByValue_spy.callCount).to.equal(test_instance.fetch_attributes.length);
			})
		);

		it(
			'should set values to the data[table].__merged_data property for specified hash from ORDER BY clause',
			mochaAsyncWrapper(async function () {
				const expected_result = TEST_DATA_DOG.reduce((acc, col) => {
					acc[col.id] = [col.id];
					return acc;
				}, {});
				const test_sql_orderby = `${sql_basic_dog_select} ORDER BY id`;
				setupTestInstance(test_sql_orderby);

				await test_instance._getFetchAttributeValues();
				const test_data_result = test_instance.data[dog_schema_table_id()].__merged_data;

				expect(test_instance.fetch_attributes.length).to.equal(1);
				expect(test_data_result).to.deep.equal(expected_result);
				expect(_getDataByValue_spy.calledOnce).to.equal(true);
			})
		);

		it(
			'should set values to the data[table].__merged_data property for specified attribute value from ORDER BY clause',
			mochaAsyncWrapper(async function () {
				const name_attr_key = 'name';
				const expected_result_name = TEST_DATA_DOG.reduce((acc, col) => {
					acc[col.id] = [col.id, col.name];
					return acc;
				}, {});
				const test_sql_orderby = `${sql_basic_dog_select} ORDER BY ${name_attr_key}`;
				setupTestInstance(test_sql_orderby);

				await test_instance._getFetchAttributeValues();
				const test_data_result = test_instance.data[dog_schema_table_id()].__merged_data;

				expect(test_instance.fetch_attributes.length).to.equal(2);
				expect(test_data_result).to.deep.equal(expected_result_name);
				expect(_getDataByValue_spy.calledTwice).to.equal(true);
			})
		);

		it(
			'should set row attr values that do not come back as null in final row data in to the data[table].__merged_data property',
			mochaAsyncWrapper(async function () {
				const name_attr_key = 'name';
				const null_attr_key = 'null_attr';
				const expected_result_name = TEST_DATA_CAT.reduce((acc, col) => {
					acc[col.id] = [col.id, col.name, null];
					return acc;
				}, {});
				const test_sql_null = `${sql_basic_cat_select} ORDER BY ${name_attr_key}, ${null_attr_key}`;
				setupTestInstance(test_sql_null);

				await test_instance._getFetchAttributeValues();
				const test_data_result = test_instance.data[cat_schema_table_id()].__merged_data;

				expect(test_instance.fetch_attributes.length).to.equal(3);
				expect(test_data_result).to.eql(expected_result_name);
				expect(_getDataByValue_spy.calledThrice).to.equal(true);
			})
		);
	});

	describe('_getFinalAttributeData()', function () {
		after(function () {
			_getData_spy.restore();
		});

		it(
			'should return/skip if row_count equals 0',
			mochaAsyncWrapper(async function () {
				const existing_attrs = { dog: ['id'] };
				const joined_length = 0;
				setupTestInstance();
				sandbox.resetHistory();
				await test_instance._getFinalAttributeData(existing_attrs, joined_length);

				expect(_findColumn_spy.called).to.equal(false);
				expect(_getData_spy.called).to.equal(false);
			})
		);

		it(
			'should consolidate unique columns/attributes and pass them to _getData()',
			mochaAsyncWrapper(async function () {
				const existing_attrs = { dog: ['id'] };
				const joined_length = 6;
				const expected_columns = [
					{ attribute: 'age', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'breed', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'name', table: { databaseid: 'dev', tableid: 'dog' } },
				];
				const columns = {
					columns: [
						{ columnid: '*' },
						{ columnid: 'age', tableid: 'dog' },
						{ columnid: 'breed', tableid: 'dog' },
						{ columnid: 'id', tableid: 'dog' },
						{ columnid: 'name', tableid: 'dog' },
					],
					order: [{ columnid: 'id' }, { columnid: 'name' }],
				};
				const all_attrs = [
					{ attribute: 'age', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'breed', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'id', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'name', table: { databaseid: 'dev', tableid: 'dog' } },
				];
				setupTestInstance();
				_getData_spy = _getData_spy.returns();
				test_instance.all_table_attributes = all_attrs;
				test_instance.columns = columns;

				await test_instance._getFinalAttributeData(existing_attrs, joined_length);

				expect(_getData_spy.calledOnce).to.equal(true);
				expect(_getData_spy.calledWith(expected_columns)).to.equal(true);
			})
		);
	});

	describe('_getData()', function () {
		it(
			'should set data.merged_data property with hash attributes values',
			mochaAsyncWrapper(async function () {
				const all_columns = [
					{ attribute: 'age', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'breed', table: { databaseid: 'dev', tableid: 'dog' } },
					{ attribute: 'name', table: { databaseid: 'dev', tableid: 'dog' } },
				];
				const not_simple_select = sql_basic_dog_select + ' ORDER BY id';

				setupTestInstance(not_simple_select);
				await test_instance._getFetchAttributeValues();
				sandbox.resetHistory();

				await test_instance._getData(all_columns);

				const test_merged_data = test_instance.data[dog_schema_table_id()].__merged_data;

				expect(_getDataByHash_spy.callCount).to.equal(1);
				Object.keys(test_merged_data).forEach((key) => {
					expect(Object.keys(test_merged_data[key]).length).to.equal(4);
				});
				const attr_keys = test_utils.sortAttrKeyMap(Object.keys(TEST_DATA_DOG[0]));
				TEST_DATA_DOG.forEach((row) => {
					const hash_id = row.id;
					expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
					attr_keys.forEach((attr, i) => {
						expect(test_merged_data[hash_id][i]).to.equal(row[attr]);
					});
				});
			})
		);

		it(
			'should set data.merged_data property with hash attributes values for multiple tables',
			mochaAsyncWrapper(async function () {
				const test_sql_statement =
					'SELECT d.id, d.name, d.breed, c.id, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id';
				const all_columns = [
					{ attribute: 'name', table: { databaseid: 'dev', tableid: 'dog', as: 'd' } },
					{ attribute: 'breed', table: { databaseid: 'dev', tableid: 'dog', as: 'd' } },
					{ attribute: 'age', table: { databaseid: 'dev', tableid: 'cat', as: 'c' } },
				];
				const attr_key_map_dog = [`id`, `name`, `breed`];
				const attr_key_map_cat = [`id`, `age`];

				setupTestInstance(test_sql_statement);
				await test_instance._getFetchAttributeValues();
				sandbox.resetHistory();

				await test_instance._getData(all_columns);

				const test_merged_data_dog = test_instance.data[dog_schema_table_id('d')].__merged_data;
				const test_merged_data_cat = test_instance.data[cat_schema_table_id('c')].__merged_data;

				expect(_getDataByHash_spy.callCount).to.equal(2);
				Object.keys(test_merged_data_dog).forEach((key) => {
					expect(Object.keys(test_merged_data_dog[key]).length).to.equal(3);
				});
				Object.keys(test_merged_data_cat).forEach((key) => {
					expect(Object.keys(test_merged_data_cat[key]).length).to.equal(2);
				});
				TEST_DATA_DOG.forEach((row) => {
					const hash_id = row.id;
					expect(Object.keys(test_merged_data_dog[hash_id]).length).to.equal(3);
					attr_key_map_dog.forEach((attr, i) => {
						expect(test_merged_data_dog[hash_id][i]).to.equal(row[attr]);
					});
				});
				TEST_DATA_CAT.forEach((row) => {
					const hash_id = row.id;
					expect(Object.keys(test_merged_data_cat[hash_id]).length).to.equal(2);
					attr_key_map_cat.forEach((attr, i) => {
						expect(test_merged_data_cat[hash_id][i]).to.equal(row[attr]);
					});
				});
			})
		);

		it(
			'should set longtext/blob values in the data.__merged_data property',
			mochaAsyncWrapper(async function () {
				const test_sql_statement = `SELECT * FROM dev.longtext WHERE id IN(${sql_where_in_ids.toString()})`;
				const all_columns = [{ attribute: 'remarks', table: { databaseid: 'dev', tableid: 'longtext' } }];
				const expected_results = TEST_DATA_LONGTEXT.filter((row) => row.id < 4);

				setupTestInstance(test_sql_statement);
				await test_instance._getFetchAttributeValues();

				sandbox.resetHistory();
				await test_instance._getData(all_columns);

				const test_merged_data = test_instance.data[longtext_schema_table_id()].__merged_data;

				expect(_getDataByHash_spy.callCount).to.equal(1);
				Object.keys(test_merged_data).forEach((key) => {
					expect(Object.keys(test_merged_data[key]).length).to.equal(2);
				});

				const attr_keys = test_utils.sortAttrKeyMap(Object.keys(expected_results[0]));
				expected_results.forEach((row) => {
					const hash_id = row.id;
					expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
					attr_keys.forEach((attr, i) => {
						expect(test_merged_data[hash_id][i]).to.equal(row[attr]);
					});
				});
			})
		);
	});

	describe('_processJoins()', function () {
		it(
			'should remove rows from `__merged_data` that do not meet WHERE clause',
			mochaAsyncWrapper(async function () {
				const expected_attr_keys = ['id', 'name', 'breed'];
				const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${sql_where_in_ids}) ORDER BY ${expected_attr_keys.toString()}`;
				setupTestInstance(test_sql_statement);
				await test_instance._getFetchAttributeValues();
				const merged_data = test_instance.data[dog_schema_table_id()].__merged_data;
				const expected_merged_data = Object.keys(merged_data).reduce((acc, key) => {
					if (sql_where_in_ids.includes(parseInt(key))) {
						acc[key] = merged_data[key];
					}
					return acc;
				}, {});

				const test_results = await test_instance._processJoins();

				expect(test_results.joined_length).to.equal(sql_where_in_ids.length);
				const test_result_table_attrs = test_results.existing_attributes[TEST_TABLE_DOG];
				expect(test_result_table_attrs.length).to.equal(expected_attr_keys.length);
				test_result_table_attrs.forEach((attr) => {
					expect(expected_attr_keys.includes(attr)).to.equal(true);
				});
				expect(merged_data).to.deep.equal(expected_merged_data);
			})
		);

		it(
			'should update merged_data for each table based on overlap of JOIN clause',
			mochaAsyncWrapper(async function () {
				const test_sql_statement =
					'SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY d.id, d.name, d.breed';
				const expected_attr_keys_d = ['id', 'name', 'breed'];
				setupTestInstance(test_sql_statement);
				await test_instance._getFetchAttributeValues();
				const merged_data_d = test_instance.data[dog_schema_table_id('d')].__merged_data;
				const merged_data_c = test_instance.data[cat_schema_table_id('c')].__merged_data;
				const expected_merged_data_d = Object.keys(merged_data_d).reduce((acc, key) => {
					if (Object.keys(merged_data_c).includes(key)) {
						acc[key] = merged_data_d[key];
					}
					return acc;
				}, {});
				const expected_merged_data_c = deepClone(merged_data_c);

				const test_results = await test_instance._processJoins();

				expect(test_results.joined_length).to.equal(2);
				const test_result_table_attrs_d = test_results.existing_attributes['d'];
				expect(test_result_table_attrs_d.length).to.equal(3);
				test_result_table_attrs_d.forEach((attr) => {
					expect(expected_attr_keys_d.includes(attr)).to.equal(true);
				});
				const test_result_table_attrs_c = test_results.existing_attributes['c'];
				expect(test_result_table_attrs_c.length).to.equal(1);
				expect(test_result_table_attrs_c[0]).to.equal(HASH_ATTRIBUTE);
				expect(merged_data_d).to.deep.equal(expected_merged_data_d);
				expect(merged_data_c).to.deep.equal(expected_merged_data_c);
			})
		);

		it(
			'should update __merged_data for longtext blobs based on WHERE statement',
			mochaAsyncWrapper(async function () {
				const test_regex = 'dock';
				const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;
				const expected_attr_keys = Object.keys(TEST_DATA_LONGTEXT[0]);
				setupTestInstance(test_sql_statement);
				await test_instance._getFetchAttributeValues();

				const test_results = await test_instance._processJoins();

				const merged_data = test_instance.data[longtext_schema_table_id()].__merged_data;
				const merged_data_keys = Object.keys(merged_data);
				expect(test_results.joined_length).to.equal(merged_data_keys.length);
				merged_data_keys.forEach((key) => {
					expect(merged_data[key][1].includes(test_regex)).to.equal(true);
				});
				const test_result_table_attrs = test_results.existing_attributes[TEST_TABLE_LONGTEXT];
				expect(test_result_table_attrs.length).to.equal(expected_attr_keys.length);
				test_result_table_attrs.forEach((attr) => {
					expect(expected_attr_keys.includes(attr)).to.equal(true);
				});
			})
		);
	});

	describe('_finalSQL()', function () {
		it(
			'should return final sql results sorted by id in DESC order',
			mochaAsyncWrapper(async function () {
				const expected_hashes = TEST_DATA_DOG.reduce((acc, row) => {
					acc.push(row.id);
					return acc;
				}, []);
				const expected_hashes_desc_sort = sortDesc(expected_hashes);
				const test_sql_statement = `SELECT * FROM dev.dog ORDER BY id DESC`;
				setupTestInstance(test_sql_statement);
				await test_instance._getFetchAttributeValues();
				const existing_attrs = { dog: ['id'] };
				const joined_length = 6;
				await test_instance._getFinalAttributeData(existing_attrs, joined_length);

				const test_results = await test_instance._finalSQL();

				expected_hashes_desc_sort.forEach((hash, i) => {
					expect(test_results[i][HASH_ATTRIBUTE]).to.equal(hash);
				});
				expect(_buildSQL_spy.calledOnce).to.equal(true);
			})
		);
	});

	describe('_buildSQL()', function () {
		it('should parse columns to remove extra alias in UPPER function clause', () => {
			const test_sql_statement = `SELECT id AS hash, UPPER(name) AS first_name, AVG(age) as ave_age FROM dev.dog`;
			setupTestInstance(test_sql_statement);
			const initial_statement_string = test_instance.statement.toString();
			const expected_sql_string = initial_statement_string.replace(' AS [first_name]', '');

			const test_result = test_instance._buildSQL();

			expect(test_result).to.not.equal(initial_statement_string);
			expect(test_result).to.equal(expected_sql_string);
		});

		it('should return initial statement string if there are not column functions clauses', function () {
			const test_sql_statement = `SELECT id AS hash, name AS first_name, AVG(age) as ave_age FROM dev.dog`;
			setupTestInstance(test_sql_statement);
			const initial_statement_string = test_instance.statement.toString();

			const test_result = test_instance._buildSQL();

			expect(test_result).to.equal(initial_statement_string);
		});
	});
});
