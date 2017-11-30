const mathjs = require('mathjs');

const condition_operators = ['==', '>=', '>', '<', '<='],
    condition_functions = ['in', 'like'],
    delimiter = '_';

const parseNodes = Symbol('parseNodes'),
    findTable = Symbol('findTable');

class ConditionPatterns{
    constructor(conditions, tables){
        this.conditions = conditions;
        this.tables = tables;
        this.column_conditions = [];
    }

    parser(){
        this.parseWhereClause();

        this.tables.forEach((table)=>{
            table.column_conditions = [];
            if(table.join && Object.keys(table.join).length > 0){
                let result = this.parseConditions(table.join.join);
                table.column_conditions = result.conditions[0].attributes;
            }

            //get the hash_attribute for the table and add it to the column_conditions
            let hash_attribute = {
                schema:
            };
            table.column_conditions.push()
        });
    }

    parseWhereClause(){
        let results = this.parseConditions(this.conditions);

        this.conditions = results.condition_string;
        this.column_conditions = results.conditions;
    }

    parseConditions(condition_string){
        //parse takes the conditions and breaks them into an expression tree, this allows us to get individual conditions and the attribute(s) in them
        let nodes = mathjs.parse(condition_string);

        //evaluate if this node is a single condition
        let condition_nodes = [];
        nodes.filter(function (node) {
            if(node.isOperatorNode && condition_operators.indexOf(node.op) >= 0) {
                condition_nodes.push(node);
            } else if(node.isFunctionNode && condition_functions.indexOf(node.name) >= 0){
                condition_nodes.push(node);
            }
        });

        return this[parseNodes](condition_nodes, condition_string);
    }

    //take the condition and look for attributes that we need to retrieve
    [parseNodes](nodes, condition_string){
        let conditions = [];
        nodes.forEach((node)=>{
            node.filter(function (sub_node, path, parent) {
                let attribute_object;
                if (sub_node.isAccessorNode && !parent.isAccessorNode) {
                    let table = sub_node.object.name;
                    let attribute = sub_node.index.dimensions[0].value;

                    attribute_object = {
                        table: table,
                        attribute: attribute,
                        alias: `${table}${delimiter}${attribute}`
                    };
                } else if (sub_node.isSymbolNode && !parent.isAccessorNode) {
                    attribute_object = {
                        attribute: sub_node.name,
                        alias: sub_node.name,
                        condition:sub_node
                    };
                }

                //if the condition node has an attribute we look to see if the node already exists  in the collection
                //if so we add the new attribute to the node, if not we add the new node and it's attribute
                if(attribute_object) {

                    let found_node = conditions.filter((condition) => {
                        return condition.node.toString() === node.toString().replace(/\./g,delimiter);
                    });

                    if (found_node && found_node.length > 0) {
                        found_node[0].attributes.push(attribute_object);
                    } else {
                        let stripped_column = node.toString().replace(/\./g,delimiter);
                        condition_string = condition_string.replace(new RegExp(node.toString(), 'g'), stripped_column);
                        conditions.push({
                            node:node.toString().replace(/\./g,delimiter),
                            attributes:[attribute_object]
                        });
                    }
                }
            });
        });

        //this.conditions = condition;

        //clean up the attributes by assigning their proper table name and schema
        conditions.forEach((condition)=>{
            condition.attributes.forEach((attribute)=>{
                let table = this[findTable](attribute);
                attribute.schema = table.schema;
                attribute.table = table.table;
            });
        });

        //this.column_conditions = this.column_conditions.concat(conditions);

        return {condition_string: condition_string, conditions: conditions};
    }

    [findTable](condition){
        if(this.tables.length === 1){
            return this.tables[0];
        }

        return this.tables.filter((table)=>{
            return table.table === condition.table || table.alias === condition.table;
        })[0];
    }
}

module.exports = ConditionPatterns;