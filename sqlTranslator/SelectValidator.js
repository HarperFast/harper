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
    checkConditionColumns = Symbol('checkConditionColumns'),
    createAttributeFromSplitString = Symbol('createAttributeFromSplitString'),
    validateTableJoins = Symbol('validateTableJoins');

class SelectValidator {
    constructor(statement){
        this.statement = statement;
        //get all of the tables
        this.tables = [];
        this.attribute_parser;
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
            this.tables = this[validateTables]();
            this.attribute_parser = new AttributeParser(this.statement.result, this.tables);

            let select_columns = this[validateSelectColumns]();

            this[validateTableJoins]();

            this[validateConditions](this.statement.where ? this.statement.where[0] : null);

            if(this.statement.order) {
                this.statement.order.forEach((order_by) => {
                    let order = order_by.expression ? order_by.expression : order_by;
                    this[validateOrderByColumn](select_columns, order.name);
                    order_by_columns.push(order.name);
                });
            }

            if(this.statement.group) {
                this.statement.group.expression.forEach((group_by) => {
                    let group = group_by.expression ? group_by.expression : group_by;
                    this[validateOrderByColumn](select_columns, group.name);
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

        return tables;
    }

    [validateTableJoins](){
        //evaluate table joins
        if (this.statement.from.type === 'map') {
            this.statement.from.map.forEach((table) => {
                this[validateConditions](table.constraint.on);
            });
        }
    }

    [validateSelectColumns](){
        let select_columns = this.attribute_parser.parseGetAttributes();

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
            alias: table.alias ? table.alias : schema_table[1],
            schema: schema_table[0],
            table: schema_table[1]
        };
    }

    [validateColumn](column_name){

        let table_column = column_name.split('.');

        if (this.tables.length > 1 && table_column.length === 1) {
            throw `column '${column_name}' ambiguously defined`;
        }

        if(table_column.length === 1){
            //add the only table name to the array so we can validate properly
            table_column.unshift(this.tables[0].table);
        } else {
            let found_table = _.filter(this.tables, (table) => {
                return table.table === table_column[0] || table.alias === table_column[0];
            });

            if (found_table.length === 0) {
                throw `unknown table for column '${column_name}'`;
            }
        }

        let attribute = this[createAttributeFromSplitString](table_column, column_name);
        this.attribute_parser.checkColumnExists(attribute);
    }

    //receive an array based on a string split by '.' convert it to an attribute object,
    // mainly used to verify the column exists in the schema
    [createAttributeFromSplitString](table_column, raw_name){
        let table_info = this.tables.filter((table)=>{
            return table.alias === table_column[0] || table.table === table_column[0];
        })[0];

        if(!table_info){
            throw `unknown column ${raw_name}`;
        }

        let attribute = {
            schema:table_info.schema,
            table:table_info.table,
            table_alias:table_info.alias,
            attribute:table_column[1],
            raw_name: raw_name
        };

        return attribute;
    }

    [validateOrderByColumn](select_columns, column_name){
        let table_column = column_name.split('.');

        if (this.tables.length > 1 && table_column.length === 1) {
            throw `column '${column_name}' ambiguously defined`;
        }

        if(table_column.length === 1){
            //add the only table name to the array so we can validate properly
            table_column.unshift(this.tables[0].table);
        }

        let attribute = this[createAttributeFromSplitString](table_column, column_name);
        this.attribute_parser.checkColumnExists(attribute);

        let col = table_column.length === 1 ? column_name : table_column[1];
        let found_column = _.filter(select_columns, (column)=>{
            return column.alias === col || column.name === col || column.name === '*';
        });

        if(found_column.length === 0){
            throw `column '${column_name}' must be in select`;
        }


    }

    [validateConditions](where_clause){
        if(where_clause) {
            let left = where_clause;

            while (left.left.type === 'expression') {
                let condition = left.right;
                this[checkConditionColumns](condition);

                left = left.left;
            }
            this[checkConditionColumns](left);
        }
    }

    [checkConditionColumns](condition){
        if(condition.left.variant === 'column') {
            this[validateColumn](condition.left.name);
        }

        if(condition.right.variant === 'column') {
            this[validateColumn](condition.right.name);
        }
    }
}

module.exports = SelectValidator;