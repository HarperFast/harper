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
    validateFunction = Symbol('validateFunction');


class AttributeParser{

    constructor(select_clause, tables){
        this.select_clause = select_clause;
        this.tables = tables;
        this.selects = [];
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
                    if(attribute){
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
                return {
                    table: table_info.table,
                    table_alias: table_info.alias,
                    attribute: column_info[1],
                    alias: column.alias ? column.alias : column_info[1]
                };
            } else {
                return {
                    table: table_info.table,
                    table_alias: table_info.alias,
                    attribute: column_info[0],
                    alias: column.alias ? column.alias : column_info[0]
                };
            }
        } else {
            throw `unknown table for column ${column.name}`
        }

        return null;
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
        expression.args.expression.forEach((exp)=>{
            switch(exp.type){
                case 'expression':
                    args.push(this[evaluateExpression](exp).reverse().join(' '));
                    break;
                case 'function':
                    args.push(this[evaluateFunction](exp));
                    break;
                case 'literal':
                    if(exp.variant === 'text'){
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