"use strict";

const search = require('../data_layer/search');
const global_schema = require('../utility/globalSchema');
const logger = require('../utility/logging/harper_logger');
const write = require('./insert');
const clone = require('clone');
const alasql = require('alasql');
const alasql_function_importer = require('../sqlTranslator/alasqlFunctionImporter');
const util = require('util');

const p_get_table_schema = util.promisify(global_schema.getTableSchema);
const p_search = util.promisify(search.search);

const terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const env = require('../utility/environment/environmentManager');

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

module.exports = {
    update: update
};

const SQL_UPDATE_ERROR_MSG = 'There was a problem performing this update. Please check the logs and try again.';

/**
 * Description
 * @method update
 * @param {} statement
 * @param {} callback
 * @return
 */
async function update(statement){
    try {
        let table_info = await p_get_table_schema(statement.table.databaseid, statement.table.tableid);
        let update_record = createUpdateRecord(statement.columns);

        //convert this update statement to a search capable statement
        let {table: from, where} = statement;
        let table_clone = clone(from);

        let where_string = hdb_utils.isEmpty(where) ? '' : ` WHERE ${where.toString()}`;

        let select_string = `SELECT ${table_info.hash_attribute} FROM ${from.toString()} ${where_string}`;
        let search_statement = alasql.parse(select_string).statements[0];

        let records = await p_search(search_statement);
        let new_records = buildUpdateRecords(update_record, records);
        return await updateRecords(table_clone, new_records);
    } catch(e){
        throw e;
    }
}

/**
 * creates a json object based on the AST
 * @param columns
 */
function createUpdateRecord(columns){
    try {
        let record = {};

        columns.forEach((column)=>{
            if("value" in column.expression){
                record[column.column.columnid] = column.expression.value;
            } else{
                record[column.column.columnid] = alasql.compile(`SELECT ${column.expression.toString()} AS [${terms.FUNC_VAL}] FROM ?`);
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
 * @param {} update_record
 * @param {} records
 * @return
 */
function buildUpdateRecords(update_record, records){
    if(hdb_utils.isEmptyOrZeroLength(records)){
        return [];
    }

    let new_records = records.map((record)=>{
        return Object.assign(record, update_record);
    });

    return new_records;
}

/**
 * Description
 * @method updateRecords
 * @param {} table
 * @param {} records
 * @return
 */
async function updateRecords(table, records){
    let update_object = {
        operation:'update',
        schema: table.databaseid,
        table: table.tableid,
        records:records
    };

    try {
        let res = await write.update(update_object);

        // With non SQL CUD actions, the `post` operation passed into OperationFunctionCaller would send the transaction to the cluster.
        // Since we don`t send Most SQL options to the cluster, we need to explicitly send it.
        if (update_object.schema !== terms.SYSTEM_SCHEMA_NAME) {
            let update_msg = hdb_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);

            if (res.update_hashes.length > 0) {
                update_msg.transaction = update_object;
                update_msg.transaction.operation = terms.OPERATIONS_ENUM.UPDATE;
                hdb_utils.sendTransactionToSocketCluster(`${update_object.schema}:${update_object.table}`, update_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
            }

            // If any new attributes are created we need to propagate them across the entire cluster.
            if (!hdb_utils.isEmptyOrZeroLength(res.new_attributes)) {
                update_msg.__transacted = true;

                res.new_attributes.forEach((attribute) => {
                    update_msg.transaction = {
                        operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
                        schema: update_object.schema,
                        table: update_object.table,
                        attribute: attribute
                    };

                    hdb_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, update_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
                });
            }
        }
        try {
            // We do not want the API returning the new attributes property.
            delete res.new_attributes;
        } catch (delete_err) {
            logger.error(`Error delete new_attributes from update response: ${delete_err}`);
        }

        return res;
    } catch(e){
        throw e;
    }
}
