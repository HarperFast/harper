"use strict";

//defines "private" functions
const findTable = Symbol('findTable'),
    parseColumn = Symbol('parseColumn'),
    parseExpression = Symbol('parseExpression'),
    createExpressionPart = Symbol('createExpressionPart'),
    evaluateExpression = Symbol('evaluateExpression');

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

    [parseExpression](expression){
        let expression_parts = this[evaluateExpression](expression);

        //the parts of the expression natively come in backwards, so we reverse
        expression_parts.reverse();

        this.selects.push({
            calculation: expression_parts.join(' '),
            alias: null
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
            part += '${' + expression.name + '}';
        }
/*
        if(final_operation){
            part += ' ' + final_operation;
        }*/

        return part;
    }
}

module.exports = AttributeParser;