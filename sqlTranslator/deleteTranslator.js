const alasql = require('alasql');
const search = require('../dataLayer/search.js');
const log = require('../utility/logging/harper_logger.js');
const harperBridge = require('../dataLayer/harperBridge/harperBridge.js');
const util = require('util');
const hdbUtils = require('../utility/common_utils.js');
const terms = require('../utility/hdbTerms.ts');
const globalSchema = require('../utility/globalSchema.js');
const transaction = require('../dataLayer/transaction.js');

const write = require('../dataLayer/insert.js');

const RECORD = 'record';
const SUCCESS = 'successfully deleted';

const cbConvertDelete = util.callbackify(convertDelete);
const pSearchSearch = util.promisify(search.search);
const pGetTableSchema = util.promisify(globalSchema.getTableSchema);

module.exports = {
	convertDelete: cbConvertDelete,
};

function generateReturnMessage(deleteResultsObject) {
	return `${deleteResultsObject.deleted_hashes.length} ${RECORD}${
		deleteResultsObject.deleted_hashes.length === 1 ? `` : `s`
	} ${SUCCESS}`;
}

async function convertDelete({ statement, hdb_user }) {
	//convert this update statement to a search capable statement
	let tableInfo = await pGetTableSchema(statement.table.databaseid, statement.table.tableid);

	//convert this delete statement to a SQL search capable statement
	hdbUtils.backtickASTSchemaItems(statement);
	let { table: from, where } = statement;

	let whereString = hdbUtils.isEmpty(where) ? '' : ` WHERE  ${where.toString()}`;
	let selectString = `SELECT ${tableInfo.hash_attribute} FROM ${from.toString()} ${whereString}`;
	let searchStatement = alasql.parse(selectString).statements[0];

	let deleteObj = {
		operation: terms.OPERATIONS_ENUM.DELETE,
		schema: from.databaseid_orig,
		table: from.tableid_orig,
		hdb_user,
	};

	try {
		//let result = await transaction.writeTransaction(tableInfo.schema, tableInfo.name, async () => {
		deleteObj.records = await pSearchSearch(searchStatement);
		let result = await harperBridge.deleteRecords(deleteObj);
		//});
		//await write.flush({ schema: tableInfo.schema, table: tableInfo.name });

		if (hdbUtils.isEmptyOrZeroLength(result.message)) {
			result.message = generateReturnMessage(result);
		}

		delete result.txn_time;

		return result;
	} catch (err) {
		log.error(err);
		if (err.hdb_code) {
			throw err.message;
		}
		throw err;
	}
}
