"use strict";

const mathjs = require('mathjs');

//defines "private" functions
const findTable = Symbol('findTable'),
    parseColumn = Symbol('parseColumn'),
    parseExpression = Symbol('parseExpression'),
    createExpressionPart = Symbol('createExpressionPart'),
    evaluateExpression = Symbol('evaluateExpression'),
    parseFunction = Symbol('parseFunction'),
    evaluateFunction = Symbol('evaluateFunction'),
    validateFunction = Symbol('validateFunction'),
    checkColumnExists = Symbol('checkColumnExists');


class AttributeParser{

    constructor(select_clause, tables){
        this.select_clause = select_clause;
        this.tables = tables;
        this.selects = [];

        this.table_metadata = {};
        this.tables.forEach((table)=>{
            if(!this.table_metadata[table.schema]) {
                this.table_metadata[table.schema] = {};
            }
            this.table_metadata[table.schema][table.table] = global.hdb_schema[table.schema][table.table];
        });
    }

    parseGetAttributes(){
        this.select_clause.forEach((column)=>{
            switch (column.type){
                case 'expression':
                    this[parseExpression](column);
                    break;
                case 'function':
                    this[parseFunction](column);
                    break;
                case 'identifier':
                    let attribute = this[parseColumn](column);
                    //need to add every column when there is an attribute named *
                    if(attribute && attribute.attribute === '*'){
                        let all_attributes = this.selects.concat(this.table_metadata[attribute.schema][attribute.table].attributes);
                        all_attributes.forEach((attr)=>{
                            this.selects.push({
                                table:attribute.table,
                                table_alias:attribute.table_alias,
                                attribute:attr.attribute,
                                alias:attr.attribute
                            });
                        });
                    } else if(attribute){
                        this.selects.push(attribute);
                    }
                    break;
            }
        });

        return this.selects;
    }

    [findTable](table_name){
        if(this.tables.length === 1){
            return this.tables[0];
        }

        return this.tables.filter((table)=>{
            return table.table === table_name || table.alias === table_name;
        })[0];
    }

    [parseColumn](column){
        let column_info = column.name.split('.');

        if (this.tables.length > 1 && column_info.length === 1) {
            throw `column '${column.name}' ambiguously defined`;
        }

        let table_info = this[findTable](column_info[0]);
        if(table_info) {
            if (column_info.length > 1 && (column_info[0] === table_info.table || column_info[0] === table_info.alias)) {

                let attribute = {
                    schema: table_info.schema,
                    table: table_info.table,
                    table_alias: table_info.alias,
                    attribute: column_info[1],
                    alias: column.alias ? column.alias : column_info[1]
                };

                return this[checkColumnExists](attribute);
            } else {
                let attribute = {
                    schema: table_info.schema,
                    table: table_info.table,
                    table_alias: table_info.alias,
                    attribute: column_info[0],
                    alias: column.alias ? column.alias : column_info[0]
                };

                return this[checkColumnExists](attribute);
            }
        } else {
            throw `unknown table for column ${column.name}`
        }

        return null;
    }

    //used to make sure column exists in the schema
    [checkColumnExists](attribute){
        if(attribute.attribute === '*'){
            return attribute;
        }

        //since our database is case sensitive we will give some leeway regarding casing.
        // if there is just one column with lowercase matching we will accomadate
        let found_attribute = this.table_metadata[attribute.schema][attribute.table].attributes.filter((column)=>{
            return column.attribute.toLowerCase() === attribute.attribute.toLowerCase();
        });

        if(!found_attribute || found_attribute.length === 0){
            throw `unknown column ${attribute.table}.${attribute.attribute} found in select`
        } else if(found_attribute.length > 1) {
            //if there are more than 2 columns we need to do an exact match on attribute names to see if the casing is correct
            let exact_column = found_attribute.filter((column)=>{
                return column.attribute === attribute.attribute;
            });

            //get here because the casing matches no attribute
            if(!exact_column || exact_column.length === 0){
                throw `unknown column ${attribute.table}.${attribute.attribute} found in select, perhaps invalid casing was used`
            } else {
                return attribute;
            }
        } else {
            //to make sure we select the correct column assign from the found_attribute
            attribute.attribute = found_attribute[0].attribute
            return attribute;
        }
    }

    [parseFunction](expression){
        let calculation = this[evaluateFunction](expression);

        this.selects.push({
            calculation: calculation,
            alias: expression.alias
        });
    }

    [evaluateFunction](expression){
        let function_name = expression.name.name;

        //in mathjs pi is not a function but rather a variable so we just return the name
        if(function_name === 'pi'){
            return function_name;
        }
        let args = [];
        if(expression.args.expression) {
            expression.args.expression.forEach((exp) => {
                switch (exp.type) {
                    case 'expression':
                        args.push(this[evaluateExpression](exp).reverse().join(' '));
                        break;
                    case 'function':
                        args.push(this[evaluateFunction](exp));
                        break;
                    case 'literal':
                        if (exp.variant === 'text') {
                            args.push(`"${exp.value}"`);
                        } else {
                            args.push(exp.value);
                        }
                        break;
                    case 'identifier':
                        this[parseColumn](exp);
                        args.push(exp.name);
                }
            });
        } else {
            args.push(expression.args.name);
        }

        //this[validateFunction](function_name, args.length);

        if(function_name === 'concat'){
            return `concat(string(${args.join(',string(')})`;
        }

        return `${function_name}(${args.join(',')})`;
    }

    [validateFunction](function_name, number_args){
        try {
            if(function_name === 'pi'){
                return;
            }

            let arg_values = [];
            for (let x = 0; x < number_args; x++) {
                arg_values.push(String(Math.floor(Math.random() * 100)));
            }

            mathjs.eval(`${function_name}(${arg_values.join(',')})`);
        } catch(e){
            throw `error with function '${function_name}': ${e.message}`;
        }
    }


    [parseExpression](expression){
        let expression_parts = this[evaluateExpression](expression);

        //the parts of the expression natively come in backwards, so we reverse
        expression_parts.reverse();

        this.selects.push({
            calculation: expression_parts.join(' '),
            alias: expression.alias
        });
    }

    [evaluateExpression](expression, final_operation){
        try {
            let expression_parts = [];
            if (expression) {

                while (expression.left) {
                    if (expression.right.left) {
                        expression_parts = expression_parts.concat(this[evaluateExpression](expression.right, expression.operation));
                    } else {
                        expression_parts.push(this[createExpressionPart](expression.operation, expression.right));
                    }

                    expression = expression.left;

                }

                expression_parts.push(this[createExpressionPart](final_operation, expression));
            }

            return expression_parts
        } catch(e){
            console.error(e);
        }
    }

    [createExpressionPart](operation, expression){
        let operator = expression.operator;

        if(expression.expression){
            expression = expression.expression;
        }

        let part = '';
        if(operation){
            part += operation + ' ';
        }

        if(operator){
            part += operator;
        }

        if(expression.value){
            part += expression.value;
        }

        if(expression.variant === 'column'){
            this[parseColumn](expression);
            part += expression.name;
        }
/*
        if(final_operation){
            part += ' ' + final_operation;
        }*/

        return part;
    }
}

module.exports = AttributeParser;