"use strict";

//defines "private" functions
const findTable = Symbol('findTable'),
    parseColumn = Symbol('parseColumn'),
    parseExpression = Symbol('parseExpression'),
    createExpressionPart = Symbol('createExpressionPart');

class AttributeParser{

    constructor(select_clause, search_object){
        this.select_clause = select_clause;
        this.search_object = search_object;
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
                        this.search_object.selects.push(attribute);
                    }
                    break;
            }
        });

        return this.search_object;
    }

    [findTable](table_name){
        if(this.search_object.tables.length === 1){
            return this.search_object.tables[0];
        }

        return this.search_object.tables.filter((table)=>{
            return table.table === table_name || table.alias === table_name;
        })[0];
    }

    [parseColumn](column){
        let column_info = column.name.split('.');
        let table_info = this[findTable](column_info[0]);
        if(table_info) {
            if (column_info.length > 1 && (column_info[0] === table_info.table || column_info[0] === table_info.alias)) {
                return {
                    table: column_info[0],
                    attribute: column_info[1],
                    alias: column.alias ? column.alias : column_info[1]
                };
            } else {
                return {
                    table: table_info.table,
                    attribute: column_info[0],
                    alias: column.alias ? column.alias : column_info[0]
                };
            }
        }

        return null;
    }

    [parseExpression](expression){
        let expression_parts = [];
        if(expression) {

            while (expression.left) {
                expression_parts.push(this[createExpressionPart](expression.operation, expression.right.operator, expression.right.expression.value, expression.right.expression.name));

                expression = expression.left;
            }

            expression_parts.push(this[createExpressionPart](expression.operation, expression.operator, expression.expression.value, expression.expression.name));
        }

        //the parts of the expression natively come in backwards, so we reverse
        expression_parts.reverse();

        this.search_object.selects.push({
            calculation: expression_parts.join(' '),
            alias: null
        });
    }

    [createExpressionPart](operation, operator, value, column){
        let part = '';
        if(operation){
            part += operation + ' ';
        }

        if(operator){
            part += operator;
        }

        if(value){
            part += value;
        }

        if(column){
            part += '${' + column + '}';
        }

        return part;
    }
}

module.exports = AttributeParser;