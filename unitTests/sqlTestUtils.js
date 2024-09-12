'use strict';

const path = require('path');
const fs = require('fs-extra');
const sql = require('../sqlTranslator/index');
const SelectValidator = require('../sqlTranslator/SelectValidator');
const test_utils = require('./test_utils');
const { createMockDB, tearDownMockDB, deepClone } = test_utils;
test_utils.preTestPrep();
const Papa = require('papaparse');
const sql_integration_data = {};
const TEST_SCHEMA_NORTHWND = 'northwnd';
let test_env = [];

module.exports = {
	setupCSVSqlData,
	cleanupCSVData,
	generateMockAST,
	sqlIntegrationData: sql_integration_data,
};
/**
 * Converts a sql statement into an AST object for an alasql operation
 * @param sql_statement
 * @returns {SelectValidator}
 */
function generateMockAST(sql_statement) {
	try {
		const test_ast = sql.convertSQLToAST(sql_statement);
		const validated_ast = new SelectValidator(test_ast.ast.statements[0]);
		validated_ast.validate();
		return validated_ast;
	} catch (e) {
		console.log(e);
	}
}

async function setupCSVSqlData() {
	const sql_csv_data = getFormattedIntegrationTestCsvData();

	for (const { hash, schema, table, data } of sql_csv_data) {
		const csv_data = deepClone(data);
		const attrs = Object.keys(data[0]);
		const test_attr = attrs[0] === hash ? attrs[1] : attrs[0];
		sql_integration_data[table] = { hash, schema, table, attrs, test_attr, data: csv_data };
		test_env.push(...(await createMockDB(hash, schema, table, data)));
	}
}

function getDirFilePaths(dir_path) {
	const file_names = fs.readdirSync(dir_path);
	return file_names.map((file) => path.join(dir_path, file));
}

function getFormattedIntegrationTestCsvData() {
	const csv_dir = path.join(process.cwd(), '../test/data/integrationTestsCsvs');
	const csv_paths = getDirFilePaths(csv_dir);
	const parsed_data = parseCsvFilesToObjArr(csv_paths).filter((obj) => obj.name !== 'InvalidAttributes');

	return parsed_data.map((obj) => {
		obj.data.forEach((data) => {
			if (data.__parsed_extra) {
				delete data.__parsed_extra;
			}
		});
		obj.hash = integration_test_data_hash_values[obj.name];
		obj.schema = TEST_SCHEMA_NORTHWND;
		obj.name = obj.name.toLowerCase();
		delete Object.assign(obj, { ['table']: obj['name'] })['name'];
		return obj;
	});
}

function parseCsvFilesToObjArr(file_paths) {
	const result = [];
	file_paths.forEach((file) => {
		const file_name = path.basename(file, '.csv');
		if (integration_test_data_hash_values[file_name]) {
			const content = fs.readFileSync(file, 'utf8');
			Papa.parse(content, {
				header: true,
				dynamicTyping: true,
				skipEmptyLines: true,
				complete: (obj) => {
					result.push({
						name: file_name,
						data: obj.data,
					});
				},
			});
		}
	});
	return result;
}

async function cleanupCSVData() {
	await tearDownMockDB(test_env);
	test_env = [];
}
// Methods for parsing and organizing data from SQL csv test data for tests above
const integration_test_data_hash_values = {
	Customers: 'customerid',
	Employees: 'employeeid',
	InvalidAttributes: 'id',
	Orderdetails: 'orderdetailid',
	Orders: 'orderid',
	Products: 'productid',
};
