"use strict";

const _ = require('lodash'),
    AttributeParser = require('./AttributeParser');

//defines "private" functions
const validateTables = Symbol('validateTables'),
    validateSelectColumns = Symbol('validateSelectColumns'),
    createTableObject = Symbol('createTableObject'),
    validateColumn = Symbol('validateColumn'),
    validateOrderByColumn = Symbol('validateOrderByColumn'),
    validateConditions = Symbol('validateConditions'),
    checkConditionColumns = Symbol('checkConditionColumns');

class SelectValidator {
    constructor(statement){
        this.statement = statement;
        this.table_metadata = {};
    }

    validator(callback){
        let condition_columns = [];
        let order_by_columns = [];

        try {
            if(!this.statement){
                return callback('invalid sql statement');
            }

            if (this.statement.having) {
                throw 'HAVING clauses are not supported at this time';
            }

            //get all of the tables
            let tables = this[validateTables]();

            let select_columns = this[validateSelectColumns](tables);

            this[validateConditions](statement.where ? statement.where[0] : null, tables);

            if(statement.order) {
                statement.order.forEach((order_by) => {
                    let order = order_by.expression ? order_by.expression : order_by;
                    this[validateOrderByColumn](select_columns, order.name);
                    order_by_columns.push(order.name);
                });
            }

            callback();

        }catch(e){
            callback(e);
        }
    }

    [validateTables](){
        let tables = [];
        if (this.statement.from.type === 'map') {
            tables.push(this[createTableObject](this.statement.from.source));
            this.statement.from.map.forEach((table) => {
                tables.push(this[createTableObject](table.source));
            });
        } else {
            tables.push(this[createTableObject](this.statement.from));
        }

        //make sure tables have unique names
        let unique_tables = _.uniqBy(tables, 'alias');
        if(unique_tables.length !== tables.length){
            throw 'table name/aliases are not distinct';
        }

        //evaluate table joins
        if (this.statement.from.type === 'map') {
            this.statement.from.map.forEach((table) => {
                this[validateConditions](table.constraint.on, tables);
            });
        }

        return tables;
    }

    [validateSelectColumns](tables){
        let attribute_parser = new AttributeParser(this.statement.result, tables);
        let select_columns = attribute_parser.parseGetAttributes();

        return select_columns;
    }

    [createTableObject](table){
        let schema_table = table.name.split('.');

        if(schema_table.length !== 2){
            throw `invalid table ${table.name}`;
        }

        if(!global.hdb_schema[schema_table[0]] || !global.hdb_schema[schema_table[0]][schema_table[1]]){
            throw `invalid table ${table.name}`;
        }

        return {
            alias: table.alias ? table.alias : schema_table,
            schema: schema_table[0],
            table: schema_table[1]
        };
    }

    [validateColumn](tables, column_name){

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

    [validateOrderByColumn](select_columns, column_name){
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

    [validateConditions](where_clause, tables){
        if(where_clause) {
            let left = where_clause;

            while (left.left.type === 'expression') {
                let condition = left.right;
                this[checkConditionColumns](condition, tables);

                left = left.left;
            }
            this[checkConditionColumns](left, tables);
        }
    }

    [checkConditionColumns](condition, tables){
        if(condition.left.variant === 'column') {
            this[validateColumn]( tables, condition.left.name);
        }

        if(condition.right.variant === 'column') {
            this[validateColumn](tables, condition.right.name);
        }
    }
}

module.exports = SelectValidator;