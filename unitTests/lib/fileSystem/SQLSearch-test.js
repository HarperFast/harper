'use strict';

const test_utils = require('../../test_utils');
test_utils.preTestPrep();
const {
    createMockFS,
    deepClone,
    getMockFSPath,
    mochaAsyncWrapper,
    tearDownMockFS,
    generateMockAST,
    sortAsc,
    sortDesc
} = test_utils;

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const fs = require('fs-extra');
const path = require('path');
const Papa = require('papaparse');
const rewire = require('rewire');
const FileSearch = rewire('../../../lib/fileSystem/SQLSearch');
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const { HASH_FOLDER_NAME } = terms;

const {
    TEST_DATA_AGGR,
    TEST_DATA_CAT,
    TEST_DATA_DOG,
    TEST_DATA_LONGTEXT
} = require('../../test_data');

const TEST_FS_DIR = getMockFSPath();
const TEST_SCHEMA = 'dev';
const TEST_SCHEMA_NORTHWND = 'northwnd';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_DOG = 'dog';
const TEST_TABLE_LONGTEXT = 'longtext';
const dog_schema_table_id = `${TEST_SCHEMA}_${TEST_TABLE_DOG}`;
const cat_schema_table_id = `${TEST_SCHEMA}_${TEST_TABLE_CAT}`;
const longtext_schema_table_id = `${TEST_SCHEMA}_${TEST_TABLE_LONGTEXT}`;

const sql_basic_dog_select = `SELECT * FROM ${TEST_SCHEMA}.${TEST_TABLE_DOG}`;
const sql_basic_calc = "2 * 4";
const sql_basic_calc_result = eval(sql_basic_calc);
const sql_basic_op = `SELECT ${sql_basic_calc}`;
const sql_integration_data = {};
const sql_where_in_ids = [1,2,3];

let test_instance;

let sandbox;
let _getColumns_spy;
let _getTables_spy;
let _conditionsToFetchAttributeValues_spy;
let _backtickAllSchemaItems_spy;
let _getFetchAttributeValues_spy;
let _checkHashValueExists_spy;
let _retrieveIds_spy;
let _readBlobFilesForSetup_spy;
let _consolidateData_spy;
let _decideReadPattern_spy;
let _readRawFiles_spy;
let _readAttributeFilesByIds_spy;
let _readAttributeValues_spy;
let _readBlobFiles_spy;
let _finalSQL_spy;
let _buildSQL_spy;
let _stripFileExtension_spy;
let readdir_spy;
let readFile_spy;
let error_logger_spy;

function setClassMethodSpies() {
    sandbox = sinon.createSandbox();
    const getHdbBasePath_stub = function() {
        return `${TEST_FS_DIR}`;
    };
    FileSearch.__set__('base_path', getHdbBasePath_stub)
    _getColumns_spy = sandbox.spy(FileSearch.prototype, '_getColumns');
    _getTables_spy = sandbox.spy(FileSearch.prototype, '_getTables');
    _conditionsToFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_conditionsToFetchAttributeValues');
    _backtickAllSchemaItems_spy = sandbox.spy(FileSearch.prototype, '_backtickAllSchemaItems');
    _getFetchAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_getFetchAttributeValues');
    _checkHashValueExists_spy = sandbox.spy(FileSearch.prototype, '_checkHashValueExists');
    _retrieveIds_spy = sandbox.spy(FileSearch.prototype, '_retrieveIds');
    _readBlobFilesForSetup_spy = sandbox.spy(FileSearch.prototype, '_readBlobFilesForSetup');
    _consolidateData_spy = sandbox.spy(FileSearch.prototype, '_consolidateData');
    _decideReadPattern_spy = sandbox.spy(FileSearch.prototype, '_decideReadPattern');
    _readRawFiles_spy = sandbox.spy(FileSearch.prototype, '_readRawFiles');
    _readAttributeFilesByIds_spy = sandbox.spy(FileSearch.prototype, '_readAttributeFilesByIds');
    _readAttributeValues_spy = sandbox.spy(FileSearch.prototype, '_readAttributeValues');
    _readBlobFiles_spy = sandbox.stub(FileSearch.prototype, '_readBlobFiles').callThrough();
    _finalSQL_spy = sandbox.spy(FileSearch.prototype, '_finalSQL');
    _buildSQL_spy = sandbox.spy(FileSearch.prototype, '_buildSQL');
    _stripFileExtension_spy = sandbox.spy(FileSearch.prototype, '_stripFileExtension');
    readdir_spy = sandbox.spy(fs, 'readdir');
    readFile_spy = sandbox.spy(fs, 'readFile');
    error_logger_spy = sandbox.spy(log, 'error');
}

function setupBasicTestData() {
    const test_data_dog = deepClone(TEST_DATA_DOG);
    const test_data_cat = deepClone(TEST_DATA_CAT);

    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_dog);
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_cat);
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_LONGTEXT, deepClone(TEST_DATA_LONGTEXT));
    createMockFS("all", "call", "aggr", deepClone(TEST_DATA_AGGR));
}

function setupCSVSqlData() {
    const sql_csv_data = getFormattedIntegrationTestCsvData();

    sql_csv_data.forEach(({ hash, schema, table, data }) => {
        const csv_data = deepClone(data);
        const attrs = Object.keys(data[0]);
        const test_attr = attrs[0] === hash ? attrs[1] : attrs[0];
        sql_integration_data[table] = { hash, schema, table, attrs, test_attr, data: csv_data };
        createMockFS(hash, schema, table, data);
    });
}

function setupTestInstance(sql_statement, set_null_attr) {
    const statement = sql_statement ? sql_statement : sql_basic_dog_select;
    const test_sql = generateMockAST(statement);
    const test_statement = test_sql.statement;
    const test_attributes = set_null_attr === true ? null : test_sql.attributes;
    test_instance = new FileSearch(test_statement, test_attributes);
}

// Used to sort the row-level attributes within the objects in an array to easily do deep equal evaluations
function sortTestRows(test_results) {
    return test_results.map(row => {
        const new_row = {};
        const sorted_keys = sortAsc(Object.keys(row));
        sorted_keys.forEach(key => {
            new_row[key] = row[key];
        });
        return new_row;
    });
}

describe('Test FileSystem Class',function() {
    this.timeout(0);

    before(function() {
        tearDownMockFS();
        setupBasicTestData();
        setClassMethodSpies();
    });

    afterEach(function() {
        test_instance = null;
        sandbox.resetHistory();
    })

    after(function() {
        tearDownMockFS();
        sandbox.restore();
        rewire('../../../lib/fileSystem/SQLSearch');
    });

    describe('constructor()',function() {
        it('should call four class methods when instantiated',function() {
            setupTestInstance();
            expect(_getColumns_spy.calledOnce).to.equal(true);
            expect(_getTables_spy.calledOnce).to.equal(true);
            expect(_conditionsToFetchAttributeValues_spy.calledOnce).to.equal(true);
            expect(_backtickAllSchemaItems_spy.calledOnce).to.equal(true);
        });

        it('should throw an exception if no statement argument is provided',function() {
            let err;
            try {
                new FileSearch(null);
            } catch(e) {
                err = e;
            }
            expect(err).to.equal('statement cannot be null');
        });
    });

    describe('search()',function() {
        it('should return all rows when there is no WHERE clause', mochaAsyncWrapper(async function() {
            setupTestInstance();

            const search_results = await test_instance.search();

            const sorted_results = sortTestRows(search_results);
            expect(sorted_results).to.deep.equal(TEST_DATA_DOG);
        }));

        it('should return matching row based on WHERE clause', mochaAsyncWrapper(async function() {
            const test_row = TEST_DATA_DOG[2];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id = ${test_row.id}`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            const sorted_results = sortTestRows(search_results);
            expect(sorted_results[0]).to.deep.equal(test_row);
        }));

        it('should return matching rows based on WHERE clause', mochaAsyncWrapper(async function() {
            const test_rows = [TEST_DATA_DOG[0], TEST_DATA_DOG[1], TEST_DATA_DOG[2]];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id <= ${TEST_DATA_DOG[2].id}`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            const sorted_results = sortTestRows(search_results);
            expect(sorted_results).to.deep.equal(test_rows);
        }));

        it('should return [] if no rows meet WHERE clause', mochaAsyncWrapper(async function() {
            const test_incorrect_id = TEST_DATA_DOG.length + 1;
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id = ${test_incorrect_id}`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results).to.be.an('array').that.has.lengthOf(0);
        }));

        it('should return the result of a operation with only a calculation', mochaAsyncWrapper(async function() {
            setupTestInstance(sql_basic_op, null);

            const search_results = await test_instance.search();

            expect(search_results[0]).to.have.property(sql_basic_calc);
            expect(search_results[0][sql_basic_calc]).to.equal(sql_basic_calc_result);
            // Validate that other methods in search() method were not called;
            expect(_getFetchAttributeValues_spy.called).to.equal(false);
            expect(_retrieveIds_spy.called).to.equal(false);
            expect(_readBlobFilesForSetup_spy.called).to.equal(false);
            expect(_consolidateData_spy.called).to.equal(false);
            expect(_decideReadPattern_spy.called).to.equal(false);
            expect(_finalSQL_spy.called).to.equal(false);
        }));
    });

    // Note: These SELECT statements scenarios were developed from the SQL integration tests scenarios
    describe('search() - testing variety of SQL statements',function() {
        before(function() {
            setupCSVSqlData();
        });

        it('Basic select by hash returns requested attribute values for hash', mochaAsyncWrapper(async function() {
            const { attrs, data, hash } = sql_integration_data.customers;
            const test_row = data[5];
            const test_sql_statement = `SELECT ${attrs.toString()} FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} = '${test_row[hash]}'`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            Object.keys(search_results[0]).forEach(key => {
                expect(search_results[0][key]).to.equal(test_row[key]);
            });
        }));

        it('Basic select by hash with wildcard returns requested attribute values for matching hashes', mochaAsyncWrapper(async function() {
            const { attrs, data, hash } = sql_integration_data.customers;
            const test_search_val = "A";
            const expected_search_results = data.filter(row => row[hash].startsWith(test_search_val));
            const sorted_attrs = attrs.sort();
            const test_sql_statement = `SELECT ${attrs.toString()} FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${hash} LIKE '${test_search_val}%'`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(expected_search_results.length);
            search_results.forEach(row => {
                expect(Object.keys(row).sort()).to.deep.equal(sorted_attrs);
            });
        }));

        it('Basic select by value returns requested attributes for matching rows', mochaAsyncWrapper(async function() {
            const { data, attrs, test_attr } = sql_integration_data.customers;
            const test_row = data[5];
            const test_sql_statement = `SELECT ${attrs.toString()} FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${test_attr} = '${test_row[test_attr]}'`;
            setupTestInstance(test_sql_statement);

            const search_result = await test_instance.search();

            expect(search_result.length).to.equal(1);
            Object.keys(search_result[0]).forEach(key => {
                expect(search_result[0][key]).to.equal(test_row[key]);
            });
        }));

        it('Basic select by value with wildcard returns requested attributes for matching rows', mochaAsyncWrapper(async function() {
            const { data } = sql_integration_data.customers;
            const test_search_val = "A";
            const attr_key = 'companyname';
            const expected_search_results = data.filter(row => row[attr_key].startsWith(test_search_val));
            const test_sql_statement = `SELECT customerid, postalcode, companyname FROM ${TEST_SCHEMA_NORTHWND}.customers WHERE ${attr_key} LIKE '${test_search_val}%'`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(expected_search_results.length).and.above(0);
            expect(Object.keys(search_results[0]).length).to.equal(3);
        }));

        it('should sort employees by hash in asc order', mochaAsyncWrapper(async function() {
            const { data, hash } = sql_integration_data.employees;
            const sorted_data = sortTestRows(data);
            const sorted_hashes = sortAsc(sorted_data, hash);
            const test_sql_statement = `SELECT ${hash}, * from ${TEST_SCHEMA_NORTHWND}.employees ORDER BY ${hash} ASC`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(sortTestRows(search_results)).to.deep.equal(sorted_hashes);
        }));

        it('should return results when reserved words are used for schema.table AND are backticked', mochaAsyncWrapper(async function() {
            const expected_data = TEST_DATA_AGGR.filter(row => row.all > 3);
            const expected_results = sortDesc(expected_data, 'all');
            const test_sql_statement = "select age AS `alter`, * from `call`.`aggr` as `and` WHERE `all` > 3 ORDER BY `and`.`all` DESC";
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(expected_results.length).and.above(0);
            search_results.forEach((row, i) => {
                expect(row.all).to.equal(expected_results[i].all);
            });
        }));

        it('should return dot & double dot attribute values', mochaAsyncWrapper(async function() {
            const test_hash_val = 11;
            const expected_result = TEST_DATA_AGGR.filter(row => row.all === test_hash_val);
            const test_sql_statement = "select * from `call`.`aggr` where `all` = " + test_hash_val;
            setupTestInstance(test_sql_statement);

            const search_result = await test_instance.search();

            expect(search_result.length).to.equal(1);
            Object.keys(search_result[0]).forEach(attr => {
                if (expected_result[0][attr] === undefined) {
                    expect(search_result[0][attr]).to.equal(null);
                } else {
                    expect(search_result[0][attr]).to.equal(expected_result[0][attr]);
                }
            });
        }));

        it('should return orders sorted by orderid in desc order', mochaAsyncWrapper(async function() {
            const { data, hash } = sql_integration_data.orders;
            const sorted_hashes = sortDesc(data, hash).map(row => row[hash]);
            const test_sql_statement = `SELECT ${hash}, * from ${TEST_SCHEMA_NORTHWND}.orders ORDER BY ${hash} DESC`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            search_results.forEach((row, i) => {
                expect(row[hash]).to.equal(sorted_hashes[i]);
            });
        }));

        it('should return count of records with attr value equal to null', mochaAsyncWrapper(async function() {
            const { data } = sql_integration_data.orders;
            const expected_result = data.filter(row => row.shipregion === null).length;
            const test_sql_statement = "SELECT COUNT(*) AS `count` FROM " + `${TEST_SCHEMA_NORTHWND}.orders WHERE shipregion IS NULL`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results[0].count).to.equal(expected_result);
        }));

        it('should return count of records with attr value NOT equal to null', mochaAsyncWrapper(async function() {
            const { data } = sql_integration_data.orders;
            const expected_result = data.filter(row => row.shipregion !== null).length;
            const test_sql_statement = "SELECT COUNT(*) AS `count` FROM " + `${TEST_SCHEMA_NORTHWND}.orders WHERE shipregion IS NOT NULL`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results[0].count).to.equal(expected_result);
        }));

        it('should return complex join sorted by summed attribute value and joined company name in desc order', mochaAsyncWrapper(async function() {
            const { data } = sql_integration_data.orderdetails;
            const expected_results_sorted = sortDesc(data, 'unitprice');
            const test_sql_statement = `SELECT a.orderid, a.productid, d.companyname, d.contactmame, b.productname, SUM(a.unitprice) AS unitprice, SUM(a.quantity), SUM(a.discount) FROM ${TEST_SCHEMA_NORTHWND}.orderdetails a JOIN ${TEST_SCHEMA_NORTHWND}.products b ON a.productid = b.productid JOIN ${TEST_SCHEMA_NORTHWND}.orders c ON a.orderid = c.orderid JOIN ${TEST_SCHEMA_NORTHWND}.customers d ON c.customerid = d.customerid GROUP BY a.orderid, a.productid, d.companyname, d.contactmame, b.productname ORDER BY unitprice DESC, d.companyname`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(expected_results_sorted.length);
            expect(search_results[0].unitprice).to.equal(expected_results_sorted[0].unitprice);
            expect(search_results[0].companyname).to.equal("Berglunds snabbk\ufffdp");
            expect(search_results[1].companyname).to.equal("Great Lakes Food Market");
        }));

        it('should return requested attributes from 5 table join statement for specified companyname', mochaAsyncWrapper(async function() {
            const test_companyname = "Alfreds Futterkiste"
            const expected_customer_data = sql_integration_data.customers.data.filter(row => row.companyname === test_companyname)[0];
            const test_sql_statement = `SELECT a.customerid, a.companyname, a.contactmame, b.orderid, b.shipname, d.productid, d.productname, d.unitprice, c.quantity, c.discount, e.employeeid, e.firstname, e.lastname FROM ${TEST_SCHEMA_NORTHWND}.customers a JOIN ${TEST_SCHEMA_NORTHWND}.orders b ON a.customerid = b.customerid JOIN ${TEST_SCHEMA_NORTHWND}.orderdetails c ON b.orderid = c.orderid JOIN ${TEST_SCHEMA_NORTHWND}.products d ON c.productid = d.productid JOIN ${TEST_SCHEMA_NORTHWND}.employees e ON b.employeeid = e.employeeid WHERE a.companyname = '${test_companyname}'`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(12);
            expect(search_results[0].companyname).to.equal(test_companyname);
            expect(search_results[0].customerid).to.equal(expected_customer_data.customerid);
            expect(search_results[0].contactname).to.equal(expected_customer_data.contactname);
        }));

        it('should count customers and group by country attribute', mochaAsyncWrapper(async function() {
            const { data } = sql_integration_data.customers;
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
            search_results.forEach(row => {
                const { counter, country } = row;
                expect(counter).to.equal(expected_results[country]);
            });
        }));

        it('should return the top 10 products by unitprice based on limit and order by', mochaAsyncWrapper(async function() {
            const test_limit = 10;
            const test_data = [...sql_integration_data.products.data];
            const expected_results = sortDesc(test_data, 'unitprice');
            expected_results.splice(test_limit);
            const test_sql_statement = `SELECT categoryid, productname, quantityperunit, unitprice, * from ${TEST_SCHEMA_NORTHWND}.products ORDER BY unitprice DESC LIMIT ${test_limit}`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(test_limit)
            expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
        }));

        it('should return count min max avg sum price of products', mochaAsyncWrapper(async function() {
            const { data } = sql_integration_data.products;
            const expected_results = data.reduce((acc, row) => {
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
            }, { allproducts: 0, minprice: null, maxprice: null, avgprice: 0, sumprice: 0 });
            const test_sql_statement = `SELECT COUNT(unitprice) AS allproducts, MIN(unitprice) AS minprice, MAX(unitprice) AS maxprice, AVG(unitprice) AS avgprice, SUM(unitprice) AS sumprice FROM ${TEST_SCHEMA_NORTHWND}.products`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(1);
            Object.keys(search_results[0]).forEach(val => {
                expect(search_results[0][val]).to.equal(expected_results[val]);
            });
        }));

        it('should return rounded unit price and group by calculated value', mochaAsyncWrapper(async function() {
            const test_alias = "Price";
            const { data } = sql_integration_data.products;
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
            search_results.forEach(val => {
                const price_val = val[test_alias];
                expect(Object.keys(val).length).to.equal(1);
                expect(expected_result.includes(price_val)).to.equal(true);
            });
        }));

        it('should return results based on wildcard and min value parameters', mochaAsyncWrapper(async function() {
            const test_search_string = "T";
            const test_search_min = 100;
            const { data } = sql_integration_data.products;
            const expected_results = data.filter(row => row.productname.startsWith(test_search_string) && row.unitprice > test_search_min);
            const test_sql_statement = `SELECT * FROM ${TEST_SCHEMA_NORTHWND}.products WHERE (productname LIKE '${test_search_string}%') AND (unitprice > ${test_search_min})`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
        }));

        it('should return longtext values based on regex', mochaAsyncWrapper(async function() {
            const test_regex = "dock"
            const expected_results = TEST_DATA_LONGTEXT.filter(row => row.remarks.includes(test_regex));
            const test_sql_statement = `SELECT * FROM dev.longtext where remarks regexp '${test_regex}'`;
            setupTestInstance(test_sql_statement);

            const search_results = await test_instance.search();

            expect(search_results.length).to.equal(expected_results.length);
            expect(sortTestRows(search_results)).to.deep.equal(sortTestRows(expected_results));
        }));
    });

    describe('_checkEmptySQL()',function() {
        it('should return undefined if attributes and columns are set in class instance', mochaAsyncWrapper(async function() {
            setupTestInstance();

            const method_results = await test_instance._checkEmptySQL();

            expect(method_results).to.equal(undefined);
        }));

        it('should return the result of a sql operation if sql is only calculation', mochaAsyncWrapper(async function() {
            setupTestInstance(sql_basic_op, null);

            const method_results = await test_instance._checkEmptySQL();

            expect(method_results[0]).to.have.property(sql_basic_calc);
            expect(method_results[0][sql_basic_calc]).to.equal(sql_basic_calc_result);
        }));
    });

    describe('_getColumns()',function() {
        it('should collect column data from the statement and set it to column property on class',function() {
            const test_sql_statement = "SELECT * FROM dev.dog";
            setupTestInstance(test_sql_statement);
            test_instance.columns = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;

            test_instance._getColumns();

            const { columns } = test_instance.columns;
            const expected_columns = Object.keys(TEST_DATA_DOG[0]);
            expected_columns.push("*");

            expect(columns.length).to.equal(expected_columns.length);
            columns.forEach(col => {
                expect(expected_columns.includes(col.columnid)).to.equal(true);
                if (col.columnid !== "*") {
                    expect(col.tableid).to.equal(TEST_TABLE_DOG);
                }
            });
        });

        it('should collect column data from statement columns, joins, and order by and set to columns property',function() {
            const test_sql_statement = "SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY d.id";
            setupTestInstance(test_sql_statement);
            test_instance.columns = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;

            test_instance._getColumns();

            const column_data = test_instance.columns;
            const { columns, joins, order } = column_data;
            const expected_columns = { id: "d", name: "d", breed: "d", age: "c" };

            expect(Object.keys(column_data).length).to.equal(3);
            expect(columns.length).to.equal(4);
            expect(joins.length).to.equal(2);
            expect(order.length).to.equal(1);
            columns.forEach(col => {
                expect(col.tableid).to.equal(expected_columns[col.columnid]);
            });
            expect(joins[0].columnid).to.equal("id");
            expect(joins[0].tableid).to.equal("d");
            expect(joins[1].columnid).to.equal("id");
            expect(joins[1].tableid).to.equal("c");
            expect(order[0].columnid).to.equal("id");
            expect(order[0].tableid).to.equal("d");
        });

        it('should search for ORDER BY element and replace the column alias with the expression from SELECT',function() {
            const test_sql_statement = "SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id";
            setupTestInstance(test_sql_statement);
            test_instance.columns = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;

            test_instance._getColumns();

            const { columns } = test_instance.columns;
            expect(columns[0].columnid).to.equal("id");
            expect(columns[0].tableid).to.equal("d");
            expect(columns[0].as).to.equal("id");
            const { columnid, tableid } = test_instance.statement.order[0].expression;
            expect(columnid).to.equal("id");
            expect(tableid).to.equal("d");
        });
    });

    describe('_getTables()',function() {
        function checkTestInstanceData(data, table_id, hash_name, has_hash, merged_data) {
            const test_table_obj = data[table_id];
            const { __hash_name, __has_hash, __merged_data } = test_table_obj;

            const exp_hash_name = hash_name ? hash_name : 'id';
            const exp_has_hash = has_hash ? has_hash : false;
            const exp_merged_data = merged_data ? merged_data : {};

            expect(test_table_obj).to.be.an('object');
            expect(__hash_name).to.equal(exp_hash_name);
            expect(__has_hash).to.equal(exp_has_hash);
            expect(__merged_data).to.deep.equal(exp_merged_data);
        }

        it('test multiple attributes from ONE table sets one table in this.data and gets hash_name from global.schema',function() {
            setupTestInstance();
            test_instance.data = {};
            test_instance.tables = [];

            test_instance._getTables();

            const { data, tables } = test_instance;
            checkTestInstanceData(data, dog_schema_table_id);
            expect(tables[0].databaseid).to.equal(TEST_SCHEMA);
            expect(tables[0].tableid).to.equal(TEST_TABLE_DOG);
        });

        it('test multiple attributes from multiple table sets multiple tables in this.data and gets hash_name from global.schema',function() {
            const test_sql_statement = "SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id";
            setupTestInstance(test_sql_statement);
            test_instance.data = {};
            test_instance.tables = [];

            test_instance._getTables();

            const { data, tables } = test_instance;
            checkTestInstanceData(data, dog_schema_table_id);
            checkTestInstanceData(data, cat_schema_table_id);
            expect(tables[0].databaseid).to.equal(TEST_SCHEMA);
            expect(tables[0].tableid).to.equal(TEST_TABLE_DOG);
            expect(tables[1].databaseid).to.equal(TEST_SCHEMA);
            expect(tables[1].tableid).to.equal(TEST_TABLE_CAT);
        });
    });

    describe('_conditionsToFetchAttributeValues()',function() {
        const test_attr_path = `${TEST_SCHEMA}/${TEST_TABLE_DOG}/${HASH_ATTRIBUTE}`;

        it('should NOT set exact_search_values property when there is no WHERE clause',function() {
            const test_sql_statement = sql_basic_dog_select;
            setupTestInstance(test_sql_statement);
            test_instance.exact_search_values = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;

            test_instance._conditionsToFetchAttributeValues();

            const test_result = test_instance.exact_search_values;
            expect(test_result).to.deep.equal({});
        });

        it('should set exact_search_values property with data from WHERE clause',function() {
            const test_hash_val = "1";
            const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} = ${test_hash_val}`;
            setupTestInstance(test_sql_statement);
            test_instance.exact_search_values = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;

            test_instance._conditionsToFetchAttributeValues();

            const test_result = test_instance.exact_search_values;
            expect(test_result[test_attr_path]).to.be.a('object');
            expect(test_result[test_attr_path].ignore).to.equal(false);
            test_result[test_attr_path].values.forEach(val => {
                expect(val).to.equal(test_hash_val);
            });
        });

        it('should set multiple values to exact_search_values property with data from WHERE IN clause',function() {
            const test_hash_vals = "1,2";
            const test_sql_statement = sql_basic_dog_select + ` WHERE ${HASH_ATTRIBUTE} IN (${test_hash_vals})`;
            setupTestInstance(test_sql_statement);
            test_instance.exact_search_values = {};
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            test_instance.statement = test_AST_statememt;

            test_instance._conditionsToFetchAttributeValues();

            const test_result = test_instance.exact_search_values;
            expect(test_result[test_attr_path]).to.be.a('object');
            expect(test_result[test_attr_path].ignore).to.equal(false);
            test_result[test_attr_path].values.forEach(val => {
                expect(["1","2"].includes(val)).to.equal(true);
            });
        });
    });

    describe('_backtickAllSchemaItems()',function() {
        function backtickString(string_val) {
          return `\`${string_val}\``;
        };

        it('should add backticks to all schema elements in statement property',function() {
            const test_sql_statement = "SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id";
            const test_AST_statememt = generateMockAST(test_sql_statement).statement;
            const expected_results = deepClone(test_AST_statememt);
            setupTestInstance(test_sql_statement);
            test_instance.statement = test_AST_statememt;

            test_instance._backtickAllSchemaItems();

            const test_statement_keys = Object.keys(test_AST_statememt);
            test_statement_keys.forEach(key => {
               test_instance.statement[key].forEach((item_vals, i) => {
                   const initial_val = expected_results[key][i];
                   switch (key) {
                       case 'columns':
                           expect(item_vals.columnid).to.equal(backtickString(initial_val.columnid));
                           expect(item_vals.tableid).to.equal(backtickString(initial_val.tableid));
                           expect(item_vals.columnid_orig).to.equal(initial_val.columnid);
                           expect(item_vals.tableid_orig).to.equal(initial_val.tableid);
                           break;
                       case 'from':
                           expect(item_vals.databaseid).to.equal(backtickString(initial_val.databaseid));
                           expect(item_vals.tableid).to.equal(backtickString(initial_val.tableid));
                           expect(item_vals.databaseid_orig).to.equal(initial_val.databaseid);
                           expect(item_vals.tableid_orig).to.equal(initial_val.tableid);
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

    describe('_findColumn()',function() {
        it('should return full column data for requested column',function() {
            const test_column = { columnid: HASH_ATTRIBUTE, tableid: TEST_TABLE_DOG };
            setupTestInstance();

            const test_result = test_instance._findColumn(test_column);

            expect(test_result.attribute).to.equal(test_column.columnid);
            expect(test_result.table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_result.table.tableid).to.equal(test_column.tableid);
        });

        it('should return column data for alias',function() {
            const test_alias = 'dogname';
            const test_sql_statement = `SELECT d.id AS id, d.name AS ${test_alias}, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY id`;
            const test_column = {columnid: test_alias};
            setupTestInstance(test_sql_statement);

            const test_result = test_instance._findColumn(test_column);

            expect(test_result.as).to.equal(test_alias);
            expect(test_result.columnid).to.equal('name');
            expect(test_result.tableid).to.equal('d');
        });

        it('should NOT return data for column that does not exist',function() {
            const test_column = {columnid: 'snoopdog'};
            setupTestInstance();

            const test_result = test_instance._findColumn(test_column);

            expect(test_result).to.equal(undefined);
        });
    });

    describe('_addFetchColumns()',function() {
        it('should add columns from JOIN clause to fetch_attributes property',function() {
            const test_sql_statement = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_instance.columns.joins);

            expect(test_instance.fetch_attributes.length).to.equal(2);
            expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[0].table.as).to.equal("d");
            expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
            expect(test_instance.fetch_attributes[1].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[1].table.as).to.equal("c");
            expect(test_instance.fetch_attributes[1].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[1].table.tableid).to.equal(TEST_TABLE_CAT);
        });

        it('should add columns from ORDER BY clause to fetch_attributes property',function() {
            const test_sql_statement = `${sql_basic_dog_select} ORDER BY id`;
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_instance.columns.order);

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
        });

        it('should add columns from WHERE clause to fetch_attributes property',function() {
            const test_sql_statement = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_instance.columns.where);

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].attribute).to.equal(HASH_ATTRIBUTE);
            expect(test_instance.fetch_attributes[0].table.databaseid).to.equal(TEST_SCHEMA);
            expect(test_instance.fetch_attributes[0].table.tableid).to.equal(TEST_TABLE_DOG);
        });

        it('should NOT add columns to fetch_attributes property if not found',function() {
            const test_sql_statement = `${sql_basic_dog_select}`;
            const test_column = {columnid: 'snoopdog'};
            setupTestInstance(test_sql_statement);

            test_instance._addFetchColumns(test_column);

            expect(test_instance.fetch_attributes.length).to.equal(0);
        });
    });

    describe('_getFetchAttributeValues()',function() {
        it('should set hash values to the fetched_attr property for basic full table select', mochaAsyncWrapper(async function() {
            const expected_result = TEST_DATA_DOG.map(col => `${col.id}`);
            const test_sql_basic = sql_basic_dog_select;
            setupTestInstance(test_sql_basic);

            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result);
            expect(readdir_spy.calledOnce).to.equal(true);
        }));

        it('should set values to the fetched_attr property for specified hash attributes from WHERE clause', mochaAsyncWrapper(async function() {
            const expected_result = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []);
            const test_sql_where = `${sql_basic_dog_select} WHERE id IN(1,2,3)`;
            setupTestInstance(test_sql_where);

            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].values.length).to.equal(expected_result.length);
            test_instance.fetch_attributes[0].values.forEach(col => {
                expect(expected_result.includes(col)).to.equal(true);
            });
            expect(_checkHashValueExists_spy.calledOnce).to.equal(true);
            expect(readdir_spy.calledOnce).to.equal(false);
        }));

        it('should set values to the fetched_attr property for specified attribute value from WHERE clause', mochaAsyncWrapper(async function() {
            const name_attr_val = "Sam";
            const expected_result = [name_attr_val];
            const test_sql_where = `${sql_basic_dog_select} WHERE name = '${name_attr_val}'`;
            setupTestInstance(test_sql_where);

            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result);
            expect(_checkHashValueExists_spy.called).to.equal(false);
            expect(readdir_spy.calledOnce).to.equal(false);
        }));

        it('should set values to the fetched_attr property for specified attributes from JOIN clause', mochaAsyncWrapper(async function() {
            const expected_result_dog = TEST_DATA_DOG.map(col => `${col.id}`);
            const expected_result_cat = TEST_DATA_CAT.map(col => `${col.id}`);
            const test_sql_join = `SELECT d.id AS id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id`;
            setupTestInstance(test_sql_join);

            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(2);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result_dog);
            expect(test_instance.fetch_attributes[1].values).to.deep.equal(expected_result_cat);
            expect(_stripFileExtension_spy.callCount).to.equal(expected_result_dog.length + expected_result_cat.length);
            expect(readdir_spy.calledTwice).to.equal(true);
        }));

        it('should set values to the fetched_attr property for specified hash from ORDER BY clause', mochaAsyncWrapper(async function() {
            const expected_result = TEST_DATA_DOG.map(col => `${col.id}`);
            const test_sql_orderby = `${sql_basic_dog_select} ORDER BY id`;
            setupTestInstance(test_sql_orderby);

            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(1);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result);
            expect(readdir_spy.calledOnce).to.equal(true);
        }));

        it('should set values to the fetched_attr property for specified attribute value from ORDER BY clause', mochaAsyncWrapper(async function() {
            const expected_result_id = TEST_DATA_DOG.map(col => `${col.id}`);
            const expected_result_name = TEST_DATA_DOG.reduce((acc, col) => {
                if (!acc.includes(`${col.name}`)) {
                    acc.push(`${col.name}`);
                }
                return acc;
            },[]);
            const name_attr_key = "name";
            const test_sql_orderby = `${sql_basic_dog_select} ORDER BY ${name_attr_key}`;
            setupTestInstance(test_sql_orderby);

            await test_instance._getFetchAttributeValues();

            expect(test_instance.fetch_attributes.length).to.equal(2);
            expect(test_instance.fetch_attributes[0].values).to.deep.equal(expected_result_id);
            expect(test_instance.fetch_attributes[1].values.length).to.equal(expected_result_name.length);
            test_instance.fetch_attributes[1].values.forEach(col => {
                expect(expected_result_name.includes(col)).to.equal(true);
            })
            expect(readdir_spy.calledTwice).to.equal(true);
            expect(_stripFileExtension_spy.callCount).to.equal(expected_result_id.length);
        }));
    });

    describe('_checkHashValueExists()',function() {
        it('should return valid hash values', mochaAsyncWrapper(async function() {
            const test_hash_ids = sortAsc(TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []));
            const test_attr_path = path.join(getMockFSPath(), TEST_SCHEMA, TEST_TABLE_DOG, HASH_FOLDER_NAME, HASH_ATTRIBUTE);
            setupTestInstance();

            const test_result = await test_instance._checkHashValueExists(test_attr_path, test_hash_ids);

            const test_result_sorted = sortAsc(test_result);
            expect(test_result_sorted).to.deep.equal(test_hash_ids);
        }));

        it('should not return invalid hash values and log them as errors', mochaAsyncWrapper(async function() {
            const test_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []);
            const expected_results = deepClone(test_hash_ids);
            test_hash_ids.push("444");
            test_hash_ids.push("445");
            const test_attr_path = path.join(getMockFSPath(), TEST_SCHEMA, TEST_TABLE_DOG, HASH_FOLDER_NAME, HASH_ATTRIBUTE);
            setupTestInstance();

            const test_result = await test_instance._checkHashValueExists(test_attr_path, test_hash_ids);

            expect(test_result.length).to.equal(expected_results.length);
            test_result.forEach(val => {
                expect(expected_results.includes(val)).to.equal(true);
            })
            expect(error_logger_spy.callCount).to.equal(2);
        }));

        it('should return [] and log errors if an incorrect attribute path is passed in', mochaAsyncWrapper(async function() {
            const test_hash_ids = TEST_DATA_DOG.reduce((acc, col) => {
                if (col.id < 4) {
                    acc.push(`${col.id}`);
                }
                return acc;
            }, []);
            const test_attr_path = path.join(getMockFSPath(), TEST_SCHEMA, TEST_TABLE_DOG, HASH_FOLDER_NAME, "snoopdog");
            setupTestInstance();

            const test_result = await test_instance._checkHashValueExists(test_attr_path, test_hash_ids);

            expect(test_result.length).to.equal(0);
            expect(error_logger_spy.callCount).to.equal(test_hash_ids.length);
        }));
    });

    describe('_retrieveIds()',function() {
        const uniq_shortened_longtext = TEST_DATA_LONGTEXT.reduce((acc, row) => {
            const clone = deepClone(row.remarks);
            clone.slice(0, 254);
            if (!acc.includes(clone)) {
                acc.push(clone);
            }
            return acc;
        },[]);

        it('should set data property with hash attributes values', mochaAsyncWrapper(async function() {
            const expected_hash_ids = TEST_DATA_DOG.map(col => col.id);
            setupTestInstance();
            await test_instance._getFetchAttributeValues();

            const test_result = await test_instance._retrieveIds();

            const test_instance_data = test_instance.data[dog_schema_table_id];
            expect(test_result).to.deep.equal({});
            expect(test_instance_data.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(TEST_DATA_DOG.length);
            expect(Object.keys(test_instance_data.id).length).to.equal(expected_hash_ids.length);
            Object.keys(test_instance_data.id).forEach(val => {
                expect(expected_hash_ids.includes(test_instance_data.id[val])).to.equal(true);
            });
        }));

        it('should set data property for dog and cat table attributes', mochaAsyncWrapper(async function() {
            const expected_hash_ids_d = TEST_DATA_DOG.map(col => col.id);
            const expected_names_d = TEST_DATA_DOG.reduce((acc, col) => {
                acc[col.id] = col.name;
                return acc;
            }, {});
            const expected_hash_ids_c = TEST_DATA_CAT.map(col => col.id);
            const test_sql_statement = `SELECT d.id, d.name AS name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY name`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_result = await test_instance._retrieveIds();

            const test_instance_data_d = test_instance.data[dog_schema_table_id];
            const test_instance_data_c = test_instance.data[cat_schema_table_id];
            expect(test_result).to.deep.equal({});
            //check this.data for dog table
            expect(test_instance_data_d.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data_d.__merged_data).length).to.equal(TEST_DATA_DOG.length);
            expect(Object.keys(test_instance_data_d.id).length).to.equal(expected_hash_ids_d.length);
            expect(Object.keys(test_instance_data_d.name).length).to.equal(TEST_DATA_DOG.length);
            Object.keys(test_instance_data_d.id).forEach(val => {
                expect(expected_hash_ids_d.includes(test_instance_data_d.id[val])).to.equal(true);
            });
            Object.keys(test_instance_data_d.name).forEach(val => {
                expect(test_instance_data_d.name[val]).to.equal(expected_names_d[val]);
            });
            //check this.data for cat table
            expect(test_instance_data_c.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data_c.__merged_data).length).to.equal(TEST_DATA_CAT.length);
            expect(Object.keys(test_instance_data_c.id).length).to.equal(expected_hash_ids_c.length);
            Object.keys(test_instance_data_c.id).forEach(val => {
                expect(expected_hash_ids_c.includes(test_instance_data_c.id[val])).to.equal(true);
            });
        }));

        it('should set data property hash values in WHERE clause', mochaAsyncWrapper(async function() {
            const test_sql_statement = `${sql_basic_dog_select} WHERE id IN(${sql_where_in_ids.toString()})`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();

            const test_instance_data = test_instance.data[dog_schema_table_id];
            expect(test_results).to.deep.equal({});
            expect(test_instance_data.__has_hash).to.equal(true);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(sql_where_in_ids.length);
            expect(Object.keys(test_instance_data.id).length).to.equal(sql_where_in_ids.length);
            Object.keys(test_instance_data.id).forEach(val => {
                expect(sql_where_in_ids.includes(test_instance_data.id[val])).to.equal(true);
            });
        }));

        it('should return blob dir paths for unique char-limited long text values and set ids in data property', mochaAsyncWrapper(async function() {
            const test_sql_statement = `SELECT * FROM dev.longtext ORDER BY remarks`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();

            const test_instance_data = test_instance.data[longtext_schema_table_id];
            expect(test_instance_data.__has_hash).to.equal(true);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(TEST_DATA_LONGTEXT.length);
            expect(Object.keys(test_results).length).to.equal(uniq_shortened_longtext.length);
        }));

        it('should return blob data for hash values in WHERE clause', mochaAsyncWrapper(async function() {
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE id IN(${sql_where_in_ids.toString()}) ORDER BY remarks`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();

            const test_results_keys = Object.keys(test_results);
            const test_instance_data = test_instance.data[longtext_schema_table_id];
            expect(test_instance_data.__has_hash).to.equal(true);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(sql_where_in_ids.length);
            expect(test_results_keys.length).to.equal(uniq_shortened_longtext.length);
        }));

        it('should set a remarks property on this.data and return all unique file paths for remarks blob dirs', mochaAsyncWrapper(async function() {
            const test_regex = "dock";
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();

            const test_results = await test_instance._retrieveIds();

            const test_results_keys = Object.keys(test_results);
            const test_instance_data = test_instance.data[longtext_schema_table_id];
            expect(test_instance_data.__has_hash).to.equal(false);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(test_instance_data.__merged_data).to.deep.equal({});
            expect(test_instance_data.remarks).to.deep.equal({});
            expect(test_results_keys.length).to.equal(uniq_shortened_longtext.length);
        }));
    });

    describe('_readBlobFilesForSetup()',function() {
        it('should break if blob_paths argument is an empty object', mochaAsyncWrapper(async function() {
            setupTestInstance();
            const initial_data_val = deepClone(test_instance.data);

            await test_instance._readBlobFilesForSetup({});

            expect(test_instance.data).to.deep.equal(initial_data_val);
            expect(readdir_spy.called).to.equal(false);
        }));

        it('should collect full blob value and assign it to hash value', mochaAsyncWrapper(async function() {
            const test_regex = "dock";
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            const test_instance_data = test_instance.data[longtext_schema_table_id];

            //validate that remarks property has not been set w/ values
            expect(Object.keys(test_instance_data.remarks).length).to.equal(0);

            await test_instance._readBlobFilesForSetup(blob_paths);

            //validate that remarks data has been set w/ full values
            expect(Object.keys(test_instance_data.remarks).length).to.equal(TEST_DATA_LONGTEXT.length);
            TEST_DATA_LONGTEXT.forEach(row => {
                expect(row.remarks).to.equal(test_instance_data.remarks[row.id]);
            })
            expect(test_instance_data.__has_hash).to.equal(false);
            expect(test_instance_data.__hash_name).to.equal(HASH_ATTRIBUTE);
            expect(Object.keys(test_instance_data.__merged_data).length).to.equal(TEST_DATA_LONGTEXT.length);
        }));
    });

    describe('_consolidateData()',function() {
        it('should collect all id and name attribute values for table into __merged_data', mochaAsyncWrapper(async function() {
            const expected_values = TEST_DATA_DOG.reduce((acc, col) => {
                acc[col.id] = {
                    age: col.age,
                    breed: col.breed,
                    name: col.name
                };
                return acc;
            }, {});
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${sql_where_in_ids}) ORDER BY id, name, breed, age`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();

            await test_instance._consolidateData();

            const test_instance_data = test_instance.data[dog_schema_table_id];
            expect(test_instance_data.__has_hash).to.equal(true);
            const merged_data_keys = Object.keys(test_instance_data.__merged_data);
            expect(merged_data_keys.length).to.equal(TEST_DATA_DOG.length);
            merged_data_keys.forEach(hash_val => {
                expect(test_instance_data.__merged_data[hash_val].age).to.equal(expected_values[hash_val].age);
                expect(test_instance_data.__merged_data[hash_val].breed).to.equal(expected_values[hash_val].breed);
                expect(test_instance_data.__merged_data[hash_val].name).to.equal(expected_values[hash_val].name);
            })
            const id_attr_keys = Object.keys(test_instance_data.id);
            expect(id_attr_keys.length).to.equal(sql_where_in_ids.length);
            id_attr_keys.forEach(val => {
                expect(sql_where_in_ids.includes(test_instance_data.id[val])).to.equal(true);
            });
        }));

        it('should nullify non-hash attribute properties in this.data after adding values to __merged_data (to free up memory)', mochaAsyncWrapper(async function() {
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${sql_where_in_ids}) ORDER BY id, name, breed, age`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();

            await test_instance._consolidateData();

            const test_instance_data = test_instance.data[dog_schema_table_id];
            expect(test_instance_data.name).to.equal(null);
            expect(test_instance_data.breed).to.equal(null);
            expect(test_instance_data.age).to.equal(null);
            expect(Object.keys(test_instance_data.id).length).to.equal(sql_where_in_ids.length);
        }));
    });

    describe('_processJoins()',function() {
        it('should remove rows from `__merged_data` that do not meet WHERE clause', mochaAsyncWrapper(async function() {
            const expected_attr_keys = ['id', 'name', 'breed'];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${sql_where_in_ids}) ORDER BY ${expected_attr_keys.toString()}`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const merged_data = test_instance.data[dog_schema_table_id].__merged_data;
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
            test_result_table_attrs.forEach(attr => {
                expect(expected_attr_keys.includes(attr)).to.equal(true);
            });
            expect(merged_data).to.deep.equal(expected_merged_data);
        }));

        it('should update merged_data for each table based on overlap of JOIN clause', mochaAsyncWrapper(async function() {
            const test_sql_statement = "SELECT d.id, d.name, d.breed, c.age FROM dev.dog d JOIN dev.cat c ON d.id = c.id ORDER BY d.id, d.name, d.breed";
            const expected_attr_keys_d = ['id', 'name', 'breed'];
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const merged_data_d = test_instance.data[dog_schema_table_id].__merged_data;
            const merged_data_c = test_instance.data[cat_schema_table_id].__merged_data;
            const expected_merged_data_d = Object.keys(merged_data_d).reduce((acc, key) => {
                if (Object.keys(merged_data_c).includes(key)) {
                    acc[key] = merged_data_d[key];
                }
                return acc;
            }, {});
            const expected_merged_data_c = deepClone(merged_data_c);

            const test_results = await test_instance._processJoins();

            expect(test_results.joined_length).to.equal(2);
            const test_result_table_attrs_d = test_results.existing_attributes[TEST_TABLE_DOG];
            expect(test_result_table_attrs_d.length).to.equal(3);
            test_result_table_attrs_d.forEach(attr => {
                expect(expected_attr_keys_d.includes(attr)).to.equal(true);
            });
            const test_result_table_attrs_c = test_results.existing_attributes[TEST_TABLE_CAT];
            expect(test_result_table_attrs_c.length).to.equal(1);
            expect(test_result_table_attrs_c[0]).to.equal(HASH_ATTRIBUTE);
            expect(merged_data_d).to.deep.equal(expected_merged_data_d);
            expect(merged_data_c).to.deep.equal(expected_merged_data_c);
        }));

        it('should update __merged_data for longtext blobs based on WHERE statement', mochaAsyncWrapper(async function() {
            const test_regex = "dock";
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE remarks regexp '${test_regex}'`;
            const expected_attr_keys = Object.keys(TEST_DATA_LONGTEXT[0]);
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            await test_instance._readBlobFilesForSetup(blob_paths);
            await test_instance._consolidateData();

            const test_results = await test_instance._processJoins();

            const merged_data = test_instance.data[longtext_schema_table_id].__merged_data;
            const merged_data_keys = Object.keys(merged_data);
            expect(test_results.joined_length).to.equal(merged_data_keys.length);
            merged_data_keys.forEach(key => {
                expect(merged_data[key].remarks.includes(test_regex)).to.equal(true);
            });
            const test_result_table_attrs = test_results.existing_attributes[TEST_TABLE_LONGTEXT];
            expect(test_result_table_attrs.length).to.equal(expected_attr_keys.length);
            test_result_table_attrs.forEach(attr => {
                expect(expected_attr_keys.includes(attr)).to.equal(true);
            });
        }));
    });

    describe('_decideReadPattern()',function() {
        it('should consolidate additional attr columns to pull for 2nd/final sql query', mochaAsyncWrapper(async function() {
            const sql_attr_keys = ['id', 'name'];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${sql_where_in_ids}) ORDER BY ${sql_attr_keys.toString()}`;
            const expected_attr_keys = Object.keys(TEST_DATA_DOG[0]).filter(key => !sql_attr_keys.includes(key));
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const join_results = await test_instance._processJoins();

            await test_instance._decideReadPattern(join_results.existing_attributes, join_results.joined_length);

            expect(_readRawFiles_spy.called).to.equal(true);
            const spy_args = _readRawFiles_spy.args[0][0];
            expect(spy_args.length).to.equal(expected_attr_keys.length);
            spy_args.forEach(arg => {
                expect(expected_attr_keys.includes(arg.attribute)).to.equal(true);
            });
        }));

        it('should call _readRawFiles if row count is <= 1000', mochaAsyncWrapper(async function() {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const join_results = await test_instance._processJoins();

            await test_instance._decideReadPattern(join_results.existing_attributes, 500);

            expect(_readRawFiles_spy.called).to.equal(true);
        }));

        it('should call _readAttributeValues if row count is > 1000', mochaAsyncWrapper(async function() {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const join_results = await test_instance._processJoins();

            await test_instance._decideReadPattern(join_results.existing_attributes, 1005);

            expect(_readAttributeValues_spy.called).to.equal(true);
        }));
    });

    describe('_readRawFiles()',function() {
        it('should collect ids for each column and call _readAttributeFilesByIds for each column', mochaAsyncWrapper(async function() {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;

            await test_instance._readRawFiles(test_columns_data);

            expect(_readAttributeFilesByIds_spy.callCount).to.equal(test_columns_data.length);
            _readAttributeFilesByIds_spy.args.forEach((data, i) => {
                expect(data[0].attribute).to.deep.equal(test_columns_data[i].attribute);
                expect(data[0].table).to.deep.equal(test_columns_data[i].table);
                expect(data[1].length).to.equal(Object.keys(test_merged_data).length);
            });
        }));

        it('should log an error if column data is not found', mochaAsyncWrapper(async function() {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            test_columns_data[0].table.databaseid = "dogzz";

            await test_instance._readRawFiles(test_columns_data);

            expect(error_logger_spy.calledOnce).to.equal(true);
            expect(error_logger_spy.args[0][0].message).to.equal(`Cannot read property '__merged_data' of undefined`);
            expect(_readAttributeFilesByIds_spy.callCount).to.equal(test_columns_data.length - 1);
        }));
    });

    describe('_readAttributeFilesByIds()',function() {
        it('should query and set attr value for ids provided', mochaAsyncWrapper(async function() {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_column = test_columns_data[0];
            const { attribute } = test_column;
            const test_ids = TEST_DATA_DOG.map(row => `${row.id}`);

            await test_instance._readAttributeFilesByIds(test_column, test_ids);

            expect(readFile_spy.callCount).to.equal(test_ids.length);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;
            Object.keys(test_merged_data).forEach(key => {
                const row_data = TEST_DATA_DOG.filter(row => key === `${row.id}`)[0];
                expect(test_merged_data[key][attribute]).to.equal(row_data[attribute]);
            });
        }));
    });

    describe('_readAttributeValues()',function() {
        before(() => {
            _readBlobFiles_spy.resolves();
        });

        after(() => {
            _readBlobFiles_spy.reset();
            _readBlobFiles_spy.callThrough();
        });

        it('should set values for all non-hash attrs in data property', mochaAsyncWrapper(async function() {
            setupTestInstance();
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(row => {
               expect(Object.keys(test_merged_data[row]).length).to.equal(1);
            });

            await test_instance._readAttributeValues(test_columns_data);

            TEST_DATA_DOG.forEach(row => {
                const hash_id = row.id;
                const attr_keys = Object.keys(row);
                expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
                attr_keys.forEach(attr => {
                    expect(test_merged_data[hash_id][attr]).to.equal(row[attr]);
                });
            });
        }));

        it('should set values for all non-hash attrs not processed in initial pass', mochaAsyncWrapper(async function() {
            const sql_attr_keys = ['id', 'name'];
            const test_sql_statement = `SELECT * FROM dev.dog WHERE id IN(${sql_where_in_ids}) ORDER BY ${sql_attr_keys.toString()}`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[dog_schema_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(row => {
               expect(Object.keys(test_merged_data[row]).length).to.equal(sql_attr_keys.length);
            });

            await test_instance._readAttributeValues(test_columns_data);

            expect(_readBlobFiles_spy.called).to.equal(false);
            TEST_DATA_DOG.forEach(row => {
                const hash_id = row.id;
                const attr_keys = Object.keys(row);
                expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
                attr_keys.forEach(attr => {
                    expect(test_merged_data[hash_id][attr]).to.equal(row[attr]);
                });
            });
        }));

        it('should call readBlobFiles to set values for all non-hash longtext attrs not processed in initial pass', mochaAsyncWrapper(async function() {
            const test_sql_statement = `SELECT * FROM dev.longtext`;

            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            await test_instance._readBlobFilesForSetup(blob_paths);
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            const test_merged_data = test_instance.data[longtext_schema_table_id].__merged_data;

            Object.keys(test_merged_data).forEach(row => {
               expect(Object.keys(test_merged_data[row]).length).to.equal(1);
            });

            await test_instance._readAttributeValues(test_columns_data);

            expect(_readBlobFiles_spy.calledOnce).to.equal(true);
            expect(Object.keys(_readBlobFiles_spy.args[0][0]).length).to.equal(24);
            Object.keys(test_merged_data).forEach(row => {
                expect(Object.keys(test_merged_data[row]).length).to.equal(1);
            });
        }));
    });

    describe('_readBlobFiles()',function() {
        const expected_results = TEST_DATA_LONGTEXT.filter(row => row.id < 4);

        //blob paths that should be passed to the method for the test rows with ids 1, 2, or 3
        const test_blob_paths = {
            "dev/longtext/remarks/RIVERFRONT LIFESTYLE! New dock, new roof and new appliances. For sale fully furnished. Beautiful custom-built 2-story home with pool. Panoramic river views and open floor plan -- great for entertaining. Hardwood floors flow throughout. Enjoy sunsets over ": {
                attribute: "remarks",
                table: {
                    databaseid: "dev",
                    tableid: "longtext"
                }
            },
            "dev/longtext/remarks/Come see the kitchen remodel and new wood flooring.  Custom built by Howard White in 2007, this immaculate Deerwood home enjoys a view of the 18th fairway. From the moment you step into the foyer, you will be impressed with the bright, open floor plan. Th": {
                attribute: "remarks",
                table: {
                    databaseid: "dev",
                    tableid: "longtext"
                }
            },
            "dev/longtext/remarks/This custom built dream home is stunningly gorgeous!  It is a 5+ acres luxury equestrian property with access to Jennings State Forest from your backyard, no need to trailer your horses anywhere for a beautifully scenic peaceful ride.  This amazing home i": {
                attribute: "remarks",
                table: {
                    databaseid: "dev",
                    tableid: "longtext"
                }
            }
        };

        it('should set longtext/blob values in the data property', mochaAsyncWrapper(async function() {
            const test_sql_statement = `SELECT * FROM dev.longtext WHERE id IN(${sql_where_in_ids.toString()})`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            const blob_paths = await test_instance._retrieveIds();
            await test_instance._readBlobFilesForSetup(blob_paths);
            await test_instance._consolidateData();
            const test_merged_data = test_instance.data[longtext_schema_table_id].__merged_data;
            Object.keys(test_merged_data).forEach(key => {
                expect(Object.keys(test_merged_data[key]).length).to.equal(1);
            });

            await test_instance._readBlobFiles(test_blob_paths);

            expected_results.forEach(row => {
                const hash_id = row.id;
                const attr_keys = Object.keys(row);
                expect(Object.keys(test_merged_data[hash_id]).length).to.equal(attr_keys.length);
                attr_keys.forEach(attr => {
                    expect(test_merged_data[hash_id][attr]).to.equal(row[attr]);
                });
            });
        }));
    });

    describe('_finalSQL()',function() {
        it('should return final sql results sorted by id in DESC order', mochaAsyncWrapper(async function() {
            const expected_hashes = TEST_DATA_DOG.reduce((acc, row) => {
                acc.push(row.id);
                return acc;
            }, []);
            const expected_hashes_desc_sort = sortDesc(expected_hashes);
            const test_sql_statement = `SELECT * FROM dev.dog ORDER BY id DESC`;
            setupTestInstance(test_sql_statement);
            await test_instance._getFetchAttributeValues();
            await test_instance._retrieveIds();
            await test_instance._consolidateData();
            const test_columns_data = test_instance.all_table_attributes.filter(data => data.attribute !== HASH_ATTRIBUTE);
            await test_instance._readRawFiles(test_columns_data);

            const test_results = await test_instance._finalSQL();

            expected_hashes_desc_sort.forEach((hash, i) => {
                expect(test_results[i][HASH_ATTRIBUTE]).to.equal(hash);
            });
            expect(_buildSQL_spy.calledOnce).to.equal(true);
        }));
    });

    describe('_buildSQL()',function() {
        it('should parse columns to remove extra alias in UPPER function clause',() => {
            const test_sql_statement = `SELECT id AS hash, UPPER(name) AS first_name, AVG(age) as ave_age FROM dev.dog`;
            setupTestInstance(test_sql_statement);
            const initial_statement_string = test_instance.statement.toString();
            const expected_sql_string = initial_statement_string.replace(" AS `first_name`", "");

            const test_result = test_instance._buildSQL();

            expect(test_result).to.not.equal(initial_statement_string);
            expect(test_result).to.equal(expected_sql_string);
        });

        it('should return initial statement string if there are not column functions clauses',function() {
            const test_sql_statement = `SELECT id AS hash, name AS first_name, AVG(age) as ave_age FROM dev.dog`;
            setupTestInstance(test_sql_statement);
            const initial_statement_string = test_instance.statement.toString();

            const test_result = test_instance._buildSQL();

            expect(test_result).to.equal(initial_statement_string);
        });
    });

    describe('_stripFileExtension()',function() {
        it('should remove `.hdb` from the argument passed',function() {
            const file_name = "very_important_file";
            const file_ext_name = ".hdb";
            const test_file_name = file_name + file_ext_name;
            setupTestInstance();

            const test_result = test_instance._stripFileExtension(test_file_name);

            expect(test_result).to.equal(file_name);
        });

        it('should return undefined if no argument is passed',function() {
            setupTestInstance();

            const test_result = test_instance._stripFileExtension();

            expect(test_result).to.equal(undefined);
        });
    });
});

// Methods for parsing and organizing data from SQL csv test data for tests above
const integration_test_data_hash_values = {
    Customers: "customerid",
    Employees: "employeeid",
    InvalidAttributes: "id",
    Orderdetails: "orderdetailid",
    Orders: "orderid",
    Products: "productid"
};

function parseCsvFilesToObjArr(file_paths) {
    const result = [];
    file_paths.forEach(file => {
        const file_name = path.basename(file, '.csv');
        if (integration_test_data_hash_values[file_name]) {
            const content = fs.readFileSync(file, "utf8");
            Papa.parse(content, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true,
                complete: (obj) => {
                    result.push({
                        name: file_name,
                        data: obj.data
                    });
                }
            });
        }
    });
    return result;
}

function getDirFilePaths(dir_path) {
    const file_names = fs.readdirSync(dir_path);
    return file_names.map(file => path.join(dir_path, file));
}

function getFormattedIntegrationTestCsvData() {
    const csv_dir = path.join(process.cwd(), '../test/data/integrationTestsCsvs');
    const csv_paths = getDirFilePaths(csv_dir);
    const parsed_data = parseCsvFilesToObjArr(csv_paths);

    return parsed_data.map(obj => {
        obj.data.forEach(data => {
            if (data.__parsed_extra) {
                delete data.__parsed_extra;
            }
        });
        obj.hash = integration_test_data_hash_values[obj.name];
        obj.schema = obj.name === "InvalidAttributes" ? TEST_SCHEMA : TEST_SCHEMA_NORTHWND;
        obj.name = obj.name.toLowerCase();
        delete Object.assign(obj, {["table"]: obj["name"] })["name"];
        return obj;
    });
}