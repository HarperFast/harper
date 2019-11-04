const alasql = require('alasql');
const search = require('../data_layer/search');
const log = require('../utility/logging/harper_logger');
const harperBridge = require('../data_layer/harperBridge/harperBridge');
const util = require('util');
const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const env = require('../utility/environment/environmentManager');

const RECORD = 'record';
const SUCCESS = 'successfully deleted';

const cb_convert_delete = util.callbackify(convertDelete);
const p_search_search = util.promisify(search.search);

module.exports = {
    convertDelete:cb_convert_delete
};

function generateReturnMessage(delete_results_object) {
    return `${delete_results_object.deleted_hashes.length} ${RECORD}${delete_results_object.deleted_hashes.length === 1 ? `` : `s`} ${SUCCESS}`;
}

async function convertDelete(statement){
    //convert this update statement to a search capable statement
    //use javascript destructuring to assign variables into from & where
    let {table: from, where} = statement;
    let search_statement = new alasql.yy.Select();
    let columns = [new alasql.yy.Column({columnid:'*', tableid: statement.table.tableid})];
    search_statement.columns = columns;
    search_statement.from = [from];
    search_statement.where = where;
    let delete_obj = {
        schema: from.databaseid,
        table: from.tableid,
    };

    try{
        delete_obj.records = await p_search_search(search_statement);
        let result = await harperBridge.deleteRecords(delete_obj);

        // With non SQL CUD actions, the `post` operation passed into OperationFunctionCaller would send the transaction to the cluster.
        // Since we don`t send Most SQL options to the cluster, we need to explicitly send it.
        if(result.deleted_hashes.length > 0) {
            if (delete_obj.schema !== terms.SYSTEM_SCHEMA_NAME) {
                let delete_msg = hdb_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
                delete_msg.transaction = delete_obj;
                delete_msg.transaction.operation = terms.OPERATIONS_ENUM.DELETE;
                delete_msg.transaction.hash_values = result.deleted_hashes;
                hdb_utils.sendTransactionToSocketCluster(`${delete_obj.schema}:${delete_obj.table}`, delete_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
            }
        }

        if(hdb_utils.isEmptyOrZeroLength(result.message)) {
            result.message = generateReturnMessage(result);
        }
        return result;
    } catch(err){
        log.error(err);
        if (err.hdb_code) {
            throw err.message;
        }
        throw err;
    }
}
