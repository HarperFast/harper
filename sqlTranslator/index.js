"use strict";

module.exports = {
    evaluateSQL: evaluateSQL,
    processAST: processAST,
    convertSQLToAST:convertSQLToAST,
    checkASTPermissions: checkASTPermissions
};

const insert = require('../data_layer/insert');
const search = require('../data_layer/search').search;
const update = require('../data_layer/update').update;
const delete_translator = require('./deleteTranslator').convertDelete;
const alasql = require('alasql');
const op_auth = require('../utility/operation_authorization');
const logger = require('../utility/logging/harper_logger');
const alasql_function_importer = require('./alasqlFunctionImporter');
const hdb_utils = require('../utility/common_utils');
//here we call to define and import custom functions to alasql
alasql_function_importer(alasql);

let UNAUTHORIZED_RESPONSE = 403;

class ParsedSQLObject {
    constructor() {
        this.ast = undefined;
        this.variant = undefined;
        this.permissions_checked = false;
    }
}

function evaluateSQL(json_message, callback) {
    let parsed_sql = convertSQLToAST(json_message.sql);
    //TODO; This is a temporary check and should be removed once validation is integrated.
    let schema = undefined;
    let statement = parsed_sql.ast.statements[0];
    if(statement instanceof alasql.yy.Insert) {
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
    if(!(statement instanceof alasql.yy.Select) && hdb_utils.isEmptyOrZeroLength(schema)) {
        return callback('No schema specified', null);
    }
    processAST(json_message, parsed_sql, (error, results)=>{
        if(error){
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
    } catch(e) {
        throw e;
    }
    if(!verify_result) {
        parsed_sql_object.permissions_checked = true;
        return false;
    }
    return true;
}

function convertSQLToAST(sql) {
    let ast_response = new ParsedSQLObject();
    if(!sql) {
        throw new Error('invalid SQL: ' + sql);
    }
    try {
        let trimmed_sql = sql.trim();
        let ast = alasql.parse(trimmed_sql);
        let variant = trimmed_sql.split(" ")[0].toLowerCase();
        ast_response.ast = ast;
        ast_response.variant = variant;
    } catch(e) {
        let split_error = e.message.split('\n');
        throw new Error(`Invalid SQL at: ${split_error[1]}`);
    }

    return ast_response;
}

function processAST(json_message, parsed_sql_object, callback){
    try {
        let sql_function = nullFunction;

        if(!parsed_sql_object.permissions_checked) {
            if(!checkASTPermissions(json_message, parsed_sql_object)) {
                return callback(UNAUTHORIZED_RESPONSE, null);
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
                sql_function = update;
                break;
            case 'delete':
                sql_function = delete_translator;
                break;
            default:
                throw new Error(`unsupported SQL type ${parsed_sql_object.variant} in SQL: ${json_message}`);
                break;
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

    insert.insert(insert_object, (err, data) => {
        if (err) {
            return callback(err);
        }

        callback(null, data);
    });
}

function createDataObjects(columns, values) {
    let records = values.map((value_objects)=>{
        //compare number of values to number of columns, if no matchie throw error
        if(columns.length !== value_objects.length){
            throw "number of values do not match number of columns in insert";
        }
        let record = {};
        //make sure none of the value entries have a columnid
        value_objects.forEach((value, x)=>{
            if(value.columnid){
                throw "cannot use a column in insert value";
            }

            record[columns[x]] = value.value;
        });

        return record;
    });

    return records;
}