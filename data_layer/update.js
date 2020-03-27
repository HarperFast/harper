"use strict";

const search = require('../data_layer/search');
const async = require('async');
const global_schema = require('../utility/globalSchema');
const logger = require('../utility/logging/harper_logger');
const write = require('./insert');
const clone = require('clone');
const alasql = require('alasql');
const alasql_function_importer = require('../sqlTranslator/alasqlFunctionImporter');
const util = require('util');
const cb_insert_update = util.callbackify(write.update);
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
function update(statement, callback){
    global_schema.getTableSchema(statement.table.databaseid, statement.table.tableid, (err, table_info)=>{
        if(err){
            callback(err);
            return;
        }

        let update_record = createUpdateRecord(statement.columns);

        //convert this update statement to a search capable statement
        let {table: from, where} = statement;
        let table_clone = clone(from);
        let search_statement = new alasql.yy.Select();
        let columns = [new alasql.yy.Column({columnid:table_info.hash_attribute, tableid: statement.table.tableid})];
        search_statement.columns = columns;
        search_statement.from = [from];
        search_statement.where = where;

        async.waterfall([
            search.search.bind(null, search_statement),
            buildUpdateRecords.bind(null, update_record),
            updateRecords.bind(null, table_clone)
        ], (waterfall_err, results) => {
            if (waterfall_err) {
                if (waterfall_err.hdb_code) {
                    return callback(null, waterfall_err.message);
                }
                return callback(waterfall_err);
            }

            callback(null, results);
        });
    });

}

/**
 * creates a json object based on the AST
 * @param columns
 */
function createUpdateRecord(columns){
    try {
        let record = {};

        columns.forEach((column)=>{
            if ("funcid" in column.expression) {
                const func_val = 'func_val';
                const func_variable = column.expression.funcid === 'CURRENT_TIMESTAMP';
                const func_value = alasql(`SELECT ${func_variable ? column.expression.funcid : column.expression.toString()} AS [${func_val}]`);
                record[column.column.columnid] = func_value[0][func_val];
            } else {
                //we want to check to validate that the value attribute exists on column.expression, if it doesn't we use the columnid
                record[column.column.columnid] = "value" in column.expression ? column.expression.value : column.expression.columnid;
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
 * @param {} callback
 * @return
 */
function buildUpdateRecords(update_record, records, callback){
    if(!records || records.length === 0){
        return callback({hdb_code:1, message: "update statement found no records to update"});
    }

    let new_records = records.map((record)=>{
        return Object.assign(record, update_record);
    });

    callback(null, new_records);
}

/**
 * Description
 * @method updateRecords
 * @param {} table
 * @param {} records
 * @param {} callback
 * @return
 */
function updateRecords(table, records, callback){
    let update_object = {
        operation:'update',
        schema: table.databaseid,
        table: table.tableid,
        records:records
    };

    cb_insert_update(update_object, (err, res) => {
        if (err) {
            callback(err);
            return;
        }

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

        callback(null, res);
    });
}
