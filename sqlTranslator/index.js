const sqliteParser = require('sqlite-parser'),
    insert = require('../data_layer/insert'),
    global_schema = require('../utility/globalSchema'),
    select_translator = require('./selectTranslator').convertSelect;

module.exports = {
    evaluateSQL: evaluateSQL
};

function evaluateSQL(sql, callback) {
    global_schema.setSchemaDataToGlobal((err, data)=>{
        if(err){
            callback(err);
            return;
        }

        processSQL(sql, (error, results)=>{
            if(error){
                callback(error);
                return;
            }

            callback(null, results);
        });
    });
}

function processSQL(sql, callback){
    try {
        console.time('ast');
        let ast = sqliteParser(sql);
        console.timeEnd('ast');
        let sql_function = nullFunction;
        switch (ast.statement[0].variant) {
            case 'select':
                sql_function = select_translator;
                break;
            case 'insert':
                //TODO add validator for insert, need to make sure columns are specified
                sql_function = convertInsert;
                break;
            default:
                break;
        }

        sql_function(ast.statement[0], (err, data) => {
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
    callback();
    console.log(sql);
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
    insert_object.hash_attribute = global.hdb_schema[schema_table[0]][schema_table[1]].hash_attribute;

    insert.insert(insert_object, (err, data) => {
        if (err) {
            callback(err);
            return;
        }

        callback(null, data);
    });
}

function convertUpdate(statement, callback) {
    let update_object = {};
    let schema_table = statement.into.name.split('.');
    update_object.schema = schema_table[0];
    update_object.table = schema_table[1];


}

function createDataObjects(columns, expressions) {
    let records = [];
    expressions.forEach((values) => {
        let record = {};
        for (let x = 0; x < values.expression.length; x++) {
            record[columns[x]] = values.expression[x].value;
        }
        records.push(record);
    });

    return records;
}