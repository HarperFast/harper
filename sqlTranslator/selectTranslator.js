const search = require('../data_layer/search');


module.exports = {
    convertSelect:convertSelect
};

function convertSelect(statement, callback) {
    let search_object = {};
    let schema_table = statement.from.name.split('.');
    search_object.schema = schema_table[0];
    search_object.table = schema_table[1];

    search_object.get_attributes = statement.result.map((column) => {
        return column.name;
    });

    let table_info = global.hdb_schema[schema_table[0]][schema_table[1]];

    search_object.hash_attribute = table_info.hash_attribute;

    if(statement.where){
        search_object.condition = parseWhereClause(statement.where[0]);
    } else {
        search_object.condition={
            attribute: table_info.hash_attribute,
            operation: '=',
            compare_value: '*'
        };
    }

    search.searchByConditions(search_object, (err, results)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, results);
    });
}

function parseWhereClause(where) {
    let condition_object = {};
    condition_object.operation = where.operation;
    condition_object.attribute = where.left.name;
    condition_object.compare_value = where.right.value;

    return condition_object;
}