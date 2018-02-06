const _ = require('lodash'),
    AttributeParser = require('./AttributeParser'),
    traverse = require('traverse');

module.exports = {
    validator: validator
};

function validator(statement, callback){

    let select_columns = [];

    let condition_columns = [];
    let order_by_columns = [];

    try {
        if(!statement){
            return callback('invalid sql statement');
        }

        /*if (statement.having) {
            throw 'HAVING clauses are not supported at this time';
        }*/

        validateTables(statement);



        let select_columns = validateSelectColumns(statement);

        validateConditions(statement.where ? statement.where[0] : null, tables);

        if(statement.order) {
            statement.order.forEach((order_by) => {
                let order = order_by.expression ? order_by.expression : order_by;
                validateOrderByColumn(select_columns, order.name);
                order_by_columns.push(order.name);
            });
        }

        callback();

    }catch(e){
        callback(e);
    }

}

function validateTables(statement){
    let tables = [];

    if(!statement.from || statement.from.length === 0){
        throw `no from clause`;
    }

    statement.from.forEach((table)=>{
        validateTable(table);
    });

    if(statement.joins){
        statement.joins.forEach((join)=>{
            validateTable(join.table);
        });
    }
}

function validateTable(table){
    if(!table.databaseid){
        throw 'schema not defined in from clause';
    }

    if(!global.hdb_schema[table.databaseid] || !global.hdb_schema[table.databaseid][table.tableid]){
        throw `invalid table ${table.databaseid}.${table.tableid}`;
    }
}

function validateAllColumns(statement){

}

function getAllColumns(statement){
    traverse(statement).forEach((node)=>{
        if(node && node.columnid){

        }
    });
}

function validateSelectColumns(statement){
    let attribute_parser = new AttributeParser(statement.result, tables);
    let select_columns = attribute_parser.parseGetAttributes();

    return select_columns;
}

function validateColumn(tables, column_name){

    let table_column = column_name.split('.');

    if (tables.length > 1 && table_column.length === 1) {
        throw `column '${column_name}' ambiguously defined`;
    }

    if(table_column.length > 1) {
        let found_table = _.filter(tables, (table) => {
            return table.table === table_column[0] || table.alias === table_column[0];
        });

        if (found_table.length === 0) {
            throw `unknown table for column '${column_name}'`;
        }
    }
}

function validateOrderByColumn(select_columns, column_name){
    let table_column = column_name.split('.');

    if(table_column.length > 1){
        let found_table = _.filter(select_columns, (column)=>{
            return (column.table === table_column[0] || column.table_alias === table_column[0]) && (column.attribute === table_column[1] || column.name === '*');
        });

        if(found_table.length === 0){
            throw `unknown table for order by column '${column_name}'`;
        }
    }

    let col = table_column.length === 1 ? column_name : table_column[1];
    let found_column = _.filter(select_columns, (column)=>{
        return column.alias === col || column.name === col || column.name === '*';
    });

    if(found_column.length === 0){
        throw `column '${column_name}' must be in select`;
    }

}

function validateConditions(where_clause, tables){
    if(where_clause) {
        let left = where_clause;

        while (left.left.type === 'expression') {
            let condition = left.right;
            checkConditionColumns(condition, tables);

            left = left.left;
        }
        checkConditionColumns(left, tables);
    }
}

function checkConditionColumns(condition, tables){
    if(condition.left.variant === 'column') {
        validateColumn( tables, condition.left.name);
    }

    if(condition.right.variant === 'column') {
        validateColumn(tables, condition.right.name);
    }
}