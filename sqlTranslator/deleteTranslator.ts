import alasql from 'alasql';
import * as search from '../dataLayer/search.ts';
import log from '../utility/logging/harper_logger.ts';
import harperBridge from '../dataLayer/harperBridge/harperBridge.ts';
import * as util from 'node:util';
import * as hdbUtils from '../utility/common_utils.ts';
import * as terms from '../utility/hdbTerms.ts';
import * as globalSchema from '../utility/globalSchema.ts';

const RECORD = 'record';
const SUCCESS = 'successfully deleted';

const pSqlSelect = util.promisify(search.sqlSelect);
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
	hdbUtils.backtickASTSchemaItems({ table: statement.table });
	let { table: from, where, queries } = statement;

	let searchStatement = (alasql as any).parse(`SELECT ${(tableInfo as any).hash_attribute} FROM ${from.toString()}`)
		.statements[0];
	// the parsed WHERE, not its text: `IS NOT NULL` is written as `IS NOT(NULL)`, which reads back as `IS (NOT NULL)`
	if (!hdbUtils.isEmpty(where)) searchStatement.where = new (alasql as any).yy.Expression({ expression: where });
	// a subquery is listed here and in the WHERE, so the search refuses it as it refuses one in a SELECT
	if (queries) searchStatement.queries = queries;

	let deleteObj: any = {
		operation: terms.OPERATIONS_ENUM.DELETE,
		schema: from.databaseid_orig,
		table: from.tableid_orig,
		hdb_user,
	};

	try {
		//let result = await transaction.writeTransaction(tableInfo.schema, tableInfo.name, async () => {
		deleteObj.records = await pSqlSelect({ statement: searchStatement, hdb_user });
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
