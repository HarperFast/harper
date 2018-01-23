const sqliteParser = require('sqlite-parser'),
    insert = require('../data_layer/insert'),
    global_schema = require('../utility/globalSchema'),
    //select_translator = require('./selectTranslator').convertSelect,
    search = require('../data_layer/search').search,
    //update_translator = require('./updateTranslator').convertUpdate,
    update = require('../data_layer/update').update,
    delete_translator = require('./deleteTranslator').convertDelete,
    winston = require('../utility/logging/winston_logger'),
    alasql = require('alasql');

module.exports = {
    evaluateSQL: evaluateSQL
};

function evaluateSQL(sql, callback) {
    processSQL(sql.sql, (error, results)=>{
        if(error){
            return callback(error);
        }

        callback(null, results);
    });
}

function processSQL(sql, callback){
    try {
        if(!sql){
            throw new Error('invalid SQL: ' + sql);
        }
        let ast = alasql.parse(sql);
        let variant = sql.split(" ")[0].toLowerCase();
        let sql_function = nullFunction;
        switch (variant) {
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
                throw new Error(`unsupported SQL type ${variant} in SQL: ${sql}`);
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

    let schema_table = statement.into;
    let insert_object = {
        schema : schema_table.databaseid,
        table : schema_table.tableid,
        operation:'insert'
    };

    let columns = statement.columns.map((column) => {
        return column.columnid;
    });

    insert_object.records = createDataObjects(columns, statement.values);

    insert.insert(insert_object, (err, data) => {
        if (err) {
            callback(err);
            return;
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