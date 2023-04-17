'use strict';

const search = require('.//search');
const global_schema = require('../utility/globalSchema');
const logger = require('../utility/logging/harper_logger');
const write = require('./insert');
const transaction = require('./transaction');
const clone = require('clone');
const alasql = require('alasql');
const alasql_function_importer = require('../sqlTranslator/alasqlFunctionImporter');
const util = require('util');

const p_get_table_schema = util.promisify(global_schema.getTableSchema);
const p_search = util.promisify(search.search);

const terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');

const transact_to_clustering_utilities = require('../utility/clustering/transactToClusteringUtilities');

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

module.exports = {
	update: update,
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
	let table_info = await p_get_table_schema(statement.table.databaseid, statement.table.tableid);
	let update_record = createUpdateRecord(statement.columns);

	//convert this update statement to a SQL search capable statement
	hdb_utils.backtickASTSchemaItems(statement);
	let { table: from, where } = statement;
	let table_clone = clone(from);

	let where_string = hdb_utils.isEmpty(where) ? '' : ` WHERE ${where.toString()}`;

	let select_string = `SELECT ${table_info.hash_attribute} FROM ${from.toString()} ${where_string}`;
	let search_statement = alasql.parse(select_string).statements[0];
	//let result = await transaction.writeTransaction(table_info.schema, table_info.name, async () => {
	let records = await p_search(search_statement);
	let new_records = buildUpdateRecords(update_record, records);
	return updateRecords(table_clone, new_records, hdb_user);
	//});
	//await write.flush({ schema: table_info.schema, table: table_info.name });
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
				record[column.column.columnid] = column.expression.value;
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
	if (hdb_utils.isEmptyOrZeroLength(records)) {
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
	let update_object = {
		operation: 'update',
		schema: table.databaseid_orig,
		table: table.tableid_orig,
		records: records,
		hdb_user,
	};

	let res = await write.update(update_object);

	// With non SQL CUD actions, the `post` operation passed into OperationFunctionCaller would send the transaction to the cluster.
	// Since we don`t send Most SQL options to the cluster, we need to explicitly send it.
	await transact_to_clustering_utilities.postOperationHandler(update_object, res);
	try {
		// We do not want the API returning the new attributes property.
		delete res.new_attributes;
		delete res.txn_time;
	} catch (delete_err) {
		logger.error(`Error delete new_attributes from update response: ${delete_err}`);
	}

	return res;
}
