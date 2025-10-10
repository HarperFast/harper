'use strict';

const search = require('./search.js');
const globalSchema = require('../utility/globalSchema.js');
const logger = require('../utility/logging/harper_logger.js');
const write = require('./insert.js');
const transaction = require('./transaction.js');
const clone = require('clone');
const alasql = require('alasql');
const alasqlFunctionImporter = require('../sqlTranslator/alasqlFunctionImporter.js');
const util = require('util');

const pGetTableSchema = util.promisify(globalSchema.getTableSchema);
const pSearch = util.promisify(search.search);

const terms = require('../utility/hdbTerms.ts');
const hdbUtils = require('../utility/common_utils.js');

//here we call to define and import custom functions to alasql
alasqlFunctionImporter(alasql);

module.exports = {
	update,
};

const SQL_UPDATE_ERROR_MSG = 'There was a problem performing this update. Please check the logs and try again.';

/**
 * This method is used specifically for SQL UPDATE statements.
 * @method update
 * @param statement
 * @param hdb_user
 * @return
 */
async function update({ statement, hdb_user }) {
	let tableInfo = await pGetTableSchema(statement.table.databaseid, statement.table.tableid);
	let update_record = createUpdateRecord(statement.columns);

	//convert this update statement to a SQL search capable statement
	hdbUtils.backtickASTSchemaItems(statement);
	let { table: from, where } = statement;
	let tableClone = clone(from);

	let whereString = hdbUtils.isEmpty(where) ? '' : ` WHERE ${where.toString()}`;

	let selectString = `SELECT ${tableInfo.hash_attribute} FROM ${from.toString()} ${whereString}`;
	let searchStatement = alasql.parse(selectString).statements[0];
	//let result = await transaction.writeTransaction(tableInfo.schema, tableInfo.name, async () => {
	let records = await pSearch(searchStatement);
	let newRecords = buildUpdateRecords(update_record, records);
	return updateRecords(tableClone, newRecords, hdb_user);
	//});
	//await write.flush({ schema: tableInfo.schema, table: tableInfo.name });
	//return result;
}

/**
 * creates a json object based on the AST
 * @param columns
 */
function createUpdateRecord(columns) {
	try {
		let record = {};

		columns.forEach((column) => {
			if ('value' in column.expression) {
				record[column.column.columnid] = column.expression.value ?? null;
			} else {
				record[column.column.columnid] = alasql.compile(
					`SELECT ${column.expression.toString()} AS [${terms.FUNC_VAL}] FROM ?`
				);
			}
		});

		return record;
	} catch (err) {
		logger.error(err);
		throw new Error(SQL_UPDATE_ERROR_MSG);
	}
}

/**
 * Description
 * @method buildUpdateRecords
 * @param {{}} update_record
 * @param {[]} records
 * @return
 */
function buildUpdateRecords(update_record, records) {
	if (hdbUtils.isEmptyOrZeroLength(records)) {
		return [];
	}

	return records.map((record) => Object.assign(record, update_record));
}

/**
 * Description
 * @method updateRecords
 * @param  table
 * @param {[{}]} records
 * @param {{}} hdb_user
 * @return
 */
async function updateRecords(table, records, hdb_user) {
	let updateObject = {
		operation: 'update',
		schema: table.databaseid_orig,
		table: table.tableid_orig,
		records,
		hdb_user,
	};

	let res = await write.update(updateObject);

	try {
		// We do not want the API returning the new attributes property.
		delete res.new_attributes;
		delete res.txn_time;
	} catch (deleteErr) {
		logger.error(`Error delete new_attributes from update response: ${deleteErr}`);
	}

	return res;
}
