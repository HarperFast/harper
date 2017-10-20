const mathjs = require('mathjs');

const condition_operators = ['==', '>=', '>', '<', '<='],
    condition_functions = ['in', 'like'];

const parseNodes = Symbol('parseNodes'),
    findTable = Symbol('findTable');

class ConditionPatterns{
    constructor(conditions, tables){
        this.conditions = conditions;
        this.tables = tables;
        this.column_conditions = [];
    }

    parseConditions(){
        //parse takes the conditions and breaks them into an expression tree, this allows us to get individual conditions and the attribute(s) in them
        let nodes = mathjs.parse(this.conditions);

        //evaluate if this node is a single condition
        let condition_nodes = []
        nodes.filter(function (node) {
            if(node.isOperatorNode && condition_operators.indexOf(node.op) >= 0) {
                condition_nodes.push(node);
            } else if(node.isFunctionNode && condition_functions.indexOf(node.name) >= 0){
                condition_nodes.push(node);
            }
        });

        this[parseNodes](condition_nodes);
    }

    //take the condition and look for attributes that we need to retrieve
    [parseNodes](nodes){
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
                        alias: `${table}_${attribute}`
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
                        return condition.node.toString() === node.toString();
                    });

                    if (found_node && found_node.length > 0) {
                        found_node[0].attributes.push(attribute_object);
                    } else {
                        conditions.push({
                            node:node.toString().replace(/\./g,'_'),
                            attributes:[attribute_object]
                        });
                    }
                }
            });
        });

        //clean up the attributes by assigning their proper table name and schema
        conditions.forEach((condition)=>{
            condition.attributes.forEach((attribute)=>{
                let table = this[findTable](attribute);
                attribute.schema = table.schema;
                attribute.table = table.table;
            });

        });

        this.column_conditions = conditions;
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