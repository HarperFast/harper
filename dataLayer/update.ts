'use strict';

import * as search from './search.ts';
import * as globalSchema from '../utility/globalSchema.ts';
import logger from '../utility/logging/harper_logger.ts';
import * as write from './insert.ts';
import clone from 'clone';
import * as alasql from 'alasql';
import alasqlFunctionImporter from '../sqlTranslator/alasqlFunctionImporter.ts';
import * as util from 'util';

const pGetTableSchema = util.promisify(globalSchema.getTableSchema);
const pSearch = util.promisify(search.search);

import * as terms from '../utility/hdbTerms.ts';
import * as hdbUtils from '../utility/common_utils.ts';

//here we call to define and import custom functions to alasql
alasqlFunctionImporter(alasql);

const SQL_UPDATE_ERROR_MSG = 'There was a problem performing this update. Please check the logs and try again.';

/**
 * This method is used specifically for SQL UPDATE statements.
 * @method update
 * @param statement
 * @param hdb_user
 * @return
 */
async function updateData({ statement, hdb_user }: any) {
	let tableInfo: any = await pGetTableSchema(statement.table.databaseid, statement.table.tableid);
	let update_record = createUpdateRecord(statement.columns);

	//convert this update statement to a SQL search capable statement
	hdbUtils.backtickASTSchemaItems(statement);
	let { table: from, where } = statement;
	let tableClone = clone(from);

	let whereString = hdbUtils.isEmpty(where) ? '' : ` WHERE ${where.toString()}`;

	let selectString = `SELECT ${tableInfo.hash_attribute} FROM ${from.toString()} ${whereString}`;
	let searchStatement = (alasql as any).parse(selectString).statements[0];
	//let result = await transaction.writeTransaction(tableInfo.schema, tableInfo.name, async () => {
	let records: any = await pSearch(searchStatement);
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
function createUpdateRecord(columns: any[]) {
	try {
		let record = {};

		columns.forEach((column) => {
			if ('value' in column.expression) {
				record[column.column.columnid] = column.expression.value ?? null;
			} else {
				record[column.column.columnid] = (alasql as any).compile(
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
function buildUpdateRecords(update_record: any, records: any[]) {
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
async function updateRecords(table: any, records: any[], hdb_user: any) {
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
export { updateData as update };
