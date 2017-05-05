/**
 * Created by kyle on 5/1/17.
 */
var sqliteParser = require('sqlite-parser'),
    insert = require('../data_layer/insert');

module.exports = {
    evaluateSQL: evaluateSQL,
}

function evaluateSQL(sql, callback) {
    console.time('ast');
    let ast = sqliteParser(sql);
    console.timeEnd('ast');
    let sql_function = nullFunction;
    switch (ast.statement[0].variant) {
        case 'select':
            sql_function = convertSelect;
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
}

function nullFunction(sql) {
    console.log(sql);
}

function convertInsert(statement, callback) {
    let insert_object = {};
    let schema_table = statement.into.name.split('.');
    insert_object.schema = schema_table[0];
    insert_object.table = schema_table[1];

    let objects = [];
    let columns = statement.into.columns.map((column) => {
        return column.name;
    });

    insert_object.records = createDataObjects(columns, statement.result);
    insert_object.hash_attribute = 'id'

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
        let column = 0;
        let record = {};
        for (let x = 0; x < values.expression.length; x++) {
            record[columns[x]] = values.expression[x].value;
        }
        records.push(record);
    });

    return records;
}

function convertSelect(statement, callback) {
    let search_object = {};
    let schema_table = statement.from.name.split('.');
    search_object.schema = schema_table[0];
    search_object.table = schema_table[1];

    search_object.get_attributes = statement.result.map((column) => {
        return column.name;
    });

    callback(null, search_object);
}