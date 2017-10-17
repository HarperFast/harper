const mathjs = require('mathjs');

const condition_operators = ['==', '>=', '>', '<', '<='],
    condition_functions = ['in', 'like'];

const parseNodes = Symbol('parseNodes');

class ConditionPatterns{
    constructor(conditions){
        this.conditions = conditions;
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
            node.filter(function (node, path, parent) {
                let attribute_object;
                if (node.isAccessorNode && !parent.isAccessorNode) {
                    let table = node.object.name;
                    let attribute = node.index.dimensions[0].value;

                    attribute_object = {
                        table: table,
                        attribute: attribute,
                        alias: `${table}_${attribute}`
                    };
                } else if (node.isSymbolNode && !parent.isAccessorNode) {
                    attribute_object = {
                        attribute: node.name,
                        alias: node.name,
                        condition:node
                    };
                }

                //if the condition node has an attribute we look to see if one has already been created\
                //if so we add the new condition to the attribute, if not add the attributes with it's condition
                if(attribute_object) {
                    let found_column = conditions.filter((column) => {
                        return column.table === attribute_object.table && column.attribute === attribute_object.attribute;
                    });

                    if (found_column && found_column.length > 0) {
                        found_column[0].conditions.push(node);
                    } else {
                        attribute_object.conditions = [node];
                        conditions.push(attribute_object);
                    }
                }
            });
        });

        this.column_conditions = conditions;
    }
}

module.exports = ConditionPatterns;