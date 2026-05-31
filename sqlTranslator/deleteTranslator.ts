import * as alasql from 'alasql';
import * as search from '../dataLayer/search.ts';
import log from '../utility/logging/harper_logger.ts';
import harperBridge from '../dataLayer/harperBridge/harperBridge.ts';
import * as util from 'util';
import * as hdbUtils from '../utility/common_utils.ts';
import * as terms from '../utility/hdbTerms.ts';
import * as globalSchema from '../utility/globalSchema.ts';

const RECORD = 'record';
const SUCCESS = 'successfully deleted';

const pSearchSearch = util.promisify(search.search);
const pGetTableSchema = util.promisify(globalSchema.getTableSchema);

function generateReturnMessage(deleteResultsObject: any) {
	return `${deleteResultsObject.deleted_hashes.length} ${RECORD}${
		deleteResultsObject.deleted_hashes.length === 1 ? `` : `s`
	} ${SUCCESS}`;
}

export async function convertDelete({ statement, hdb_user }) {
	//convert this update statement to a search capable statement
	let tableInfo = await pGetTableSchema(statement.table.databaseid, statement.table.tableid);

	//convert this delete statement to a SQL search capable statement
	hdbUtils.backtickASTSchemaItems(statement);
	let { table: from, where } = statement;

	let whereString = hdbUtils.isEmpty(where) ? '' : ` WHERE  ${where.toString()}`;
	let selectString = `SELECT ${(tableInfo as any).hash_attribute} FROM ${from.toString()} ${whereString}`;
	let searchStatement = (alasql as any).parse(selectString).statements[0];

	let deleteObj: any = {
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
