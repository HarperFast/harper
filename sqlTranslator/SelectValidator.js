"use strict";

const _ = require('lodash'),
    AttributeParser = require('./AttributeParser');

class SelectValidator {
    constructor(statement){
        this.statement = statement;
        this.table_metadata = {};
    }

    validator(statement, callback){
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
}

module.exports = SelectValidator;