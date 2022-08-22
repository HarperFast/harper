const alasql = require('alasql');
const search = require('../data_layer/search');
const log = require('../utility/logging/harper_logger');
const harperBridge = require('../data_layer/harperBridge/harperBridge');
const util = require('util');
const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const global_schema = require('../utility/globalSchema');
const transaction = require('../data_layer/transaction');

const transact_to_clustering_utilities = require('../utility/clustering/transactToClusteringUtilities');

const RECORD = 'record';
const SUCCESS = 'successfully deleted';

const cb_convert_delete = util.callbackify(convertDelete);
const p_search_search = util.promisify(search.search);
const p_get_table_schema = util.promisify(global_schema.getTableSchema);

module.exports = {
	convertDelete: cb_convert_delete,
};

function generateReturnMessage(delete_results_object) {
	return `${delete_results_object.deleted_hashes.length} ${RECORD}${
		delete_results_object.deleted_hashes.length === 1 ? `` : `s`
	} ${SUCCESS}`;
}

async function convertDelete({ statement, hdb_user }) {
	//convert this update statement to a search capable statement
	let table_info = await p_get_table_schema(statement.table.databaseid, statement.table.tableid);

	//convert this delete statement to a SQL search capable statement
	hdb_utils.backtickASTSchemaItems(statement);
	let { table: from, where } = statement;

	let where_string = hdb_utils.isEmpty(where) ? '' : ` WHERE  ${where.toString()}`;
	let select_string = `SELECT ${table_info.hash_attribute} FROM ${from.toString()} ${where_string}`;
	let search_statement = alasql.parse(select_string).statements[0];

	let delete_obj = {
		operation: terms.OPERATIONS_ENUM.DELETE,
		schema: from.databaseid_orig,
		table: from.tableid_orig,
		hdb_user: hdb_user,
	};

	try {
		let result = await transaction.writeTransaction(table_info.schema, table_info.name, async () => {
			delete_obj.records = await p_search_search(search_statement);
			return harperBridge.deleteRecords(delete_obj);
		});

		// With non SQL CUD actions, the `post` operation passed into OperationFunctionCaller would send the transaction to the cluster.
		// Since we don`t send Most SQL options to the cluster, we need to explicitly send it.
		if (result.deleted_hashes.length > 0) {
			await transact_to_clustering_utilities.postOperationHandler(delete_obj, result);
		}

		if (hdb_utils.isEmptyOrZeroLength(result.message)) {
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
