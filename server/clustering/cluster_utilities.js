const insert = require('../../data_layer/insert'),
    node_Validator = require('../../validation/nodeValidator');


    function addNode(new_node, callback){
    // need to clean up new node as it hads operation and user on it
    let validation = node_Validator(new_node);
    if(validation){
        return callback(validation);
    }

    let new_node_insert = {
        "operation":"insert",
        "schema":"system",
        "table":"hdb_nodes",
        "records": [new_node]
    }

    insert.insert(new_node_insert, function(err, result){
        if(err){
            return callback(err);
        }
        return callback(null, `successfully added ${new_node.name} to manifest`);


    });

}

module.exports = {
        addNode: addNode
}