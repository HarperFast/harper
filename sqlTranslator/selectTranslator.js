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

function parseFromClause(from){
    let from_object = {};
    if(from.type === 'identifier'){
        let schema_table = from.name.split('.');
        from_object.schema = schema_table[0];
        from_object.table = schema_table[1];


        return from_object;
    } else {
        from_object = parseFromClause(from.source);

        let join = {
            type: from.map[0].variant
        };
    }
}

function parseFromSource(source){
    source.name.split('.');
    return {
        schema: schema_table[0],
        table: schema_table[1],
        alias: source.alias
    };
}

function parseConstraint(constraint){
    let from_object = parseFromClause(constraint.source);
}

function parseWhereClause(where) {
    let condition_object = {};
    condition_object.operation = where.operation;
    condition_object.attribute = where.left.name;

    switch(where.operation){
        case '=':
            condition_object.compare_value = where.right.value;
            break;
        case 'in':
            condition_object.compare_value = [];
            where.right.expression.forEach((value_object)=>{
                condition_object.compare_value.push(value_object.value);
            });
            break;
        default:
            break;
    }

    return condition_object;
}