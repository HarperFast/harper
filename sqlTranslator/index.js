const sqliteParser = require('sqlite-parser'),
    insert = require('../data_layer/insert'),
    global_schema = require('../utility/globalSchema'),
    select_translator = require('./selectTranslator').convertSelect,
    update_translator = require('./updateTranslator').convertUpdate,
    delete_translator = require('./deleteTranslator').convertDelete,
    alasql = require('alasql'),
    op_auth = require('../utility/operation_authorization'),
    winston = require('../utility/logging/winston_logger');

module.exports = {
    evaluateSQL: evaluateSQL
};

let UNAUTHORIZED_RESPONSE = 403;

function evaluateSQL(sql, callback) {
    processSQL(sql, (error, results)=>{
        if(error){
            return callback(error);
        }

        callback(null, results);
    });
}

function processSQL(sql, callback){
    try {
        if(!sql || !sql.sql) {
            throw new Error('invalid SQL: ' + sql);
        }
        let ast = alasql.parse(sql.sql);
        let variant = sql.sql.split(" ")[0].toLowerCase();
        let sql_function = nullFunction;

        if(!op_auth.verifyPermsAst(ast.statements[0], sql.hdb_user, variant)) {
            return callback(UNAUTHORIZED_RESPONSE, null);
        }
        switch (variant) {
            case 'select':
                sql_function = select_translator;
                break;
            case 'insert':
                //TODO add validator for insert, need to make sure columns are specified
                sql_function = convertInsert;
                break;
            case 'update':
                sql_function = update_translator;
                break;
            case 'delete':
                sql_function = delete_translator;
                break;
            default:
                break;
        }

        sql_function(ast.statements[0], (err, data) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, data);
        });
    } catch(e){
        callback(e);
    }
}

function nullFunction(sql, callback) {
    callback('unknown sql statement');
    winston.info(sql);
}

function convertInsert(statement, callback) {

    let schema_table = statement.into.name.split('.');
    let insert_object = {
        schema : schema_table[0],
        table : schema_table[1],
        operation:'insert'
    };

    let columns = statement.into.columns.map((column) => {
        return column.name;
    });

    insert_object.records = createDataObjects(columns, statement.result);

    insert.insert(insert_object, (err, data) => {
        if (err) {
            callback(err);
            return;
        }

        callback(null, data);
    });
}

function createDataObjects(columns, expressions) {
    let records = [];
    expressions.forEach((values) => {
        let record = {};
        for (let x = 0; x < values.expression.length; x++) {
            if(values.expression[x].type === 'identifier' && (values.expression[x].name === 'true' || values.expression[x].name === 'false')){
                record[columns[x]] = (values.expression[x].name === 'true');
            } else if(values.expression[x].type === 'literal'){
                record[columns[x]] = values.expression[x].value;
            }
        }
        records.push(record);
    });

    return records;
}