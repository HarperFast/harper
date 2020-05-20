"use strict";

module.exports = {
    evaluateSQL,
    processAST,
    convertSQLToAST,
    checkASTPermissions
};

const insert = require('../data_layer/insert');
const util = require('util');
const cb_insert_insert = util.callbackify(insert.insert);
const search = require('../data_layer/search').search;
const update = require('../data_layer/update').update;
const cb_update_update = util.callbackify(update);
const delete_translator = require('./deleteTranslator').convertDelete;
const alasql = require('alasql');
const op_auth = require('../utility/operation_authorization');
const logger = require('../utility/logging/harper_logger');
const alasql_function_importer = require('./alasqlFunctionImporter');
const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const env = require('../utility/environment/environmentManager');

//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

let UNAUTHORIZED_RESPONSE = 403;
const SQL_INSERT_ERROR_MSG = 'There was a problem performing this insert. Please check the logs and try again.';

class ParsedSQLObject {
    constructor() {
        this.ast = undefined;
        this.variant = undefined;
        this.permissions_checked = false;
    }
}

function evaluateSQL(json_message, callback) {
    let parsed_sql = json_message.parsed_sql_object;
    if(!parsed_sql) {
        parsed_sql = convertSQLToAST(json_message.sql);
        //TODO; This is a temporary check and should be removed once validation is integrated.
        let schema = undefined;
        let statement = parsed_sql.ast.statements[0];
        if (statement instanceof alasql.yy.Insert) {
            schema = statement.into.databaseid;
        } else if (statement instanceof alasql.yy.Select) {
            schema = statement.from ? statement.from[0].databaseid : null;
        } else if (statement instanceof alasql.yy.Update) {
            schema = statement.table.databaseid;
        } else if (statement instanceof alasql.yy.Delete) {
            schema = statement.table.databaseid;
        } else {
            logger.error(`AST in evaluateSQL is not a valid SQL type.`);
        }
        if (!(statement instanceof alasql.yy.Select) && hdb_utils.isEmptyOrZeroLength(schema)) {
            return callback('No schema specified', null);
        }
    }
    processAST(json_message, parsed_sql, (error, results) => {
        if (error) {
            return callback(error);
        }

        callback(null, results);
    });
}

/**
 * Provides a direct path to checking permissions for a given AST.  Returns false if permissions check fails.
 * @param json_message - The JSON inbound message.
 * @param parsed_sql_object - The Parsed SQL statement specified in the inbound json message, of type ParsedSQLObject.
 * @returns {boolean} - False if permissions check denys the statement.
 */
function checkASTPermissions(json_message, parsed_sql_object) {
    let verify_result = undefined;
    try {
        verify_result = op_auth.verifyPermsAst(parsed_sql_object.ast.statements[0], json_message.hdb_user, parsed_sql_object.variant);
        parsed_sql_object.permissions_checked = true;
    } catch(e) {
        throw e;
    }
    if (verify_result && verify_result.length > 0) {
        parsed_sql_object.permissions_checked = true;
        return verify_result;
    }
    return [];
}

function convertSQLToAST(sql) {
    let ast_response = new ParsedSQLObject();
    if (!sql) {
        throw new Error('sql parameter is missing');
    }
    try {
        let trimmed_sql = sql.trim();
        let ast = alasql.parse(trimmed_sql);
        let variant = trimmed_sql.split(" ")[0].toLowerCase();
        ast_response.ast = ast;
        ast_response.variant = variant;
    } catch(e) {
        let split_error = e.message.split('\n');
        if (split_error[1]) {
            throw new Error(`Invalid SQL at: ${split_error[1]}. Please ensure your SQL is valid. Try adding backticks to reserved words and schema table references.`);
        } else {
            throw new Error(`We had trouble parsing your request. Please ensure your SQL is valid. Try adding backticks to reserved words and schema table references.`);
        }
    }

    return ast_response;
}

function processAST(json_message, parsed_sql_object, callback) {
    try {
        let sql_function = nullFunction;

        if (!parsed_sql_object.permissions_checked) {
            let permissions_check = checkASTPermissions(json_message, parsed_sql_object);
            if (permissions_check && permissions_check.length > 0) {
                return callback(UNAUTHORIZED_RESPONSE, permissions_check);
            }
        }
        switch (parsed_sql_object.variant) {
            case 'select':
                sql_function = search;
                break;
            case 'insert':
                //TODO add validator for insert, need to make sure columns are specified
                sql_function = convertInsert;
                break;
            case 'update':
                sql_function = cb_update_update;
                break;
            case 'delete':
                sql_function = delete_translator;
                break;
            default:
                throw new Error(`unsupported SQL type ${parsed_sql_object.variant} in SQL: ${json_message}`);
        }

        sql_function(parsed_sql_object.ast.statements[0], (err, data) => {
            if (err) {
                callback(err);
                return;
            }
            callback(null, data);
        });
    } catch(e){
        return callback(e);
    }
}

function nullFunction(sql, callback) {
    logger.info(sql);
    callback('unknown sql statement');
}


function convertInsert(statement, callback) {
    let schema_table = statement.into;
    let insert_object = {
        schema : schema_table.databaseid,
        table : schema_table.tableid,
        operation:'insert'
    };

    let columns = statement.columns.map((column) => {
        return column.columnid;
    });

    try {
        insert_object.records = createDataObjects(columns, statement.values);
    } catch(e){
        return callback(e);
    }

    cb_insert_insert(insert_object, (err, res) => {
        if (err) {
            return callback(err);
        }

        // With non SQL CUD actions, the `post` operation passed into OperationFunctionCaller would send the transaction to the cluster.
        // Since we don`t send Most SQL options to the cluster, we need to explicitly send it.
        if (insert_object.schema !== terms.SYSTEM_SCHEMA_NAME) {
            let insert_msg = hdb_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);

            if (res.inserted_hashes.length > 0) {
                insert_msg.transaction = insert_object;
                insert_msg.transaction.operation = terms.OPERATIONS_ENUM.INSERT;
                hdb_utils.sendTransactionToSocketCluster(`${insert_object.schema}:${insert_object.table}`, insert_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
            }

            // If any new attributes are created we need to propagate them across the entire cluster.
            if (!hdb_utils.isEmptyOrZeroLength(res.new_attributes)) {
                insert_msg.__transacted = true;

                res.new_attributes.forEach((attribute) => {
                    insert_msg.transaction = {
                        operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
                        schema: insert_object.schema,
                        table: insert_object.table,
                        attribute: attribute
                    };

                    hdb_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, insert_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
                });
            }
        }

        try {
            // We do not want the API returning the new attributes property.
            delete res.new_attributes;
        } catch (delete_err) {
            logger.error(`Error delete new_attributes from insert response: ${delete_err}`);
        }

        callback(null, res);
    });
}

function createDataObjects(columns, values) {
    try {
        let records = values.map(value_objects => {
            //compare number of values to number of columns, if no match throw error
            if (columns.length !== value_objects.length) {
                throw "number of values do not match number of columns in insert";
            }
            let record = {};
            //make sure none of the value entries have a columnid
            value_objects.forEach((value, x) => {
                if (value.columnid) {
                    throw "cannot use a column in insert value";
                }

                if("value" in value){
                    record[columns[x]] = value.value;
                } else{
                    record[columns[x]] = alasql.compile(`SELECT ${value.toString()} AS [${terms.FUNC_VAL}] FROM ?`);
                }
            });

            return record;
        });

        return records;
    } catch(err) {
        logger.error(err);
        throw new Error(SQL_INSERT_ERROR_MSG);
    }
}
