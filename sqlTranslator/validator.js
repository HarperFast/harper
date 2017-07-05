
const sqliteParser = require('sqlite-parser'),
    _ = require('lodash');

let sql =  "select b.name, b.section, l.id, l.dog_name, b.id, l.color from dev.breed as b inner join dev.license as l on id = l.breed "  +
    "where l.color LIKE '%AC%' AND l.dog_name = 'JENNA' order by b.name asc, l.dog_name desc";
sql = sql.replace(/ like /gi, ' || ');

let ast = sqliteParser(sql);
validator(ast.statement[0], (err)=>{
    console.error(err);
});

function validator(statement, callback){
    let select_columns = [];
    let tables = [];
    let condition_columns = [];
    let order_by_columns = [];

    try {
        if (statement.group) {
            throw 'GROUP BY clauses are not supported at this time';
        }

        if (statement.having) {
            throw 'HAVING clauses are not supported at this time';
        }

        //get all of the tables
        if (statement.from.type === 'map') {
            tables.push({name: statement.from.source.name, alias: statement.from.source.alias});
            statement.from.map.forEach((table) => {
                tables.push({name: table.source.name, alias: table.source.alias});
            });
        } else {
            tables.push({name: statement.from.name, alias: statement.from.alias});
        }

        //evaluate table joins
        if (statement.from.type === 'map') {
           /* tables.push({name: statement.from.source.name, alias: statement.from.source.alias});
            statement.from.map.forEach((table) => {
                tables.push({name: table.source.name, alias: table.source.alias});
            });*/
        }

        statement.result.forEach((column) => {
            if (column.type !== 'identifier' && column.variant !== 'column') {
                throw 'invalid column in SELECT, only columns are supported, no functions or literals can be defined';
            }

            validateColumn(tables, column.name);

            select_columns.push({name: column.name, alias: column.alias});
        });

        validateConditions(statement.where, tables);

        statement.order.forEach((order_by) => {
            validateColumn(tables, order_by.expression.name);
            order_by_columns.push(order_by.expression.name);
        });

        callback();

    }catch(e){
        callback(e);
    }

}

function validateColumn(tables, column_name){
    let table_column = column_name.split('.');
    if (tables.length > 1 && table_column.length === 1) {
        throw `column '${column_name}' ambiguously defined`;
    }

    let found_table = _.filter(tables, (table)=>{
        return table.name === table_column[0] || table.alias === table_column[0];
    });

    if(found_table.length === 0){
        throw `unknown table for column '${column_name}'`;
    }
}

function validateConditions(where_clause, tables){
    if(where_clause) {
        let left = where_clause[0];

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