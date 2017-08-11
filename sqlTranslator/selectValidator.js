const _ = require('lodash');

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

        if (statement.having) {
            throw 'HAVING clauses are not supported at this time';
        }

        //get all of the tables
        let tables = validateTables(statement);

        let select_columns = validateSelectColumns(statement, tables);

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
    if (statement.from.type === 'map') {
        tables.push(createTableObject(statement.from.source));
        statement.from.map.forEach((table) => {
            tables.push(createTableObject(table.source));
        });
    } else {
        tables.push(createTableObject(statement.from));
    }

    //make sure tables have unique names
    let uniqe_tables = _.uniqBy(tables, 'alias');
    if(uniqe_tables.length !== tables.length){
        throw 'table name/aliases are not distinct';
    }

    //evaluate table joins
    if (statement.from.type === 'map') {
        statement.from.map.forEach((table) => {
            validateConditions(table.constraint.on, tables);
        });
    }

    return tables;
}

function validateSelectColumns(statement, tables){
    let select_columns = [];
    statement.result.forEach((column) => {
        if (column.type !== 'identifier' && column.variant !== 'column') {
            throw 'invalid column in SELECT, only columns are supported, no functions or literals can be defined';
        }

        validateColumn(tables, column.name);

        let table_column = column.name.split('.');
        let column_object = {
            alias: column.alias
        };

        if(table_column.length > 1){
            let found_table = _.filter(tables, (table)=>{
                return table.alias === table_column[0];
            });

            if(found_table.length === 0){
                throw `unknown table for column '${column.name}'`;
            }

            column_object.table = found_table[0].name;
            column_object.table_alias = found_table[0].alias;
            column_object.name = table_column[1];
        } else {
            column_object.table = tables[0].name;
            column_object.table_alias = tables[0].alias;
            column_object.name = table_column[0];
        }

        select_columns.push(column_object);
    });

    return select_columns;
}

function createTableObject(table){
    let schema_table = table.name.split('.');

    if(schema_table.length !== 2){
        throw `invalid table ${table.name}`;
    }

    return {
        alias: table.alias ? table.alias : schema_table,
        schema: schema_table[0],
        name: schema_table[1]
    };
}

function validateColumn(tables, column_name){

    let table_column = column_name.split('.');

    if (tables.length > 1 && table_column.length === 1) {
        throw `column '${column_name}' ambiguously defined`;
    }

    if(table_column.length > 1) {
        let found_table = _.filter(tables, (table) => {
            return table.name === table_column[0] || table.alias === table_column[0];
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
            return (column.table === table_column[0] || column.table_alias === table_column[0]) && (column.name === table_column[1] || column.name === '*');
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