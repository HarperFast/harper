const search = require('../data_layer/search');


module.exports = {
    convertSelect:convertSelect
};

function convertSelect(statement, callback) {
    let final_search_object = {};

    if(statement.from.type === 'identifier') {
        final_search_object = {
            tables:[
                generateBasicSearchObject(statement)
            ]
        };
    } else {
        generateAdvancedSearchObject(statement);
    }

    search.searchByConditions(final_search_object, (err, results)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, results);
    });
}



function generateBasicSearchObject(statement){
    let schema_table = statement.from.name.split('.');
    let search_object = {
        schema: schema_table[0],
        table: schema_table[1]
    };

    search_object.get_attributes = statement.result.map((column) => {
        return column.name;
    });

    let table_info = global.hdb_schema[schema_table[0]][schema_table[1]];

    search_object.condition = parseWhereClause(statement.where[0], table_info);

    return search_object;
}

function generateAdvancedSearchObject(statement){
    let search_wrapper = {tables:[],joins:[]};
    for(let x = 0; x <= statement.from.map.length; x++){
        let search = generateObject(statement, x);
        search_wrapper.tables.push(search.table);
        if(search.join){
            search_wrapper.joins.push(search.join);
        }
    }

    return search_wrapper;
}

function generateObject(statement, from_level){
    let from_info = {};
    let join = {};
    let table_info = {};
    if(from_level === 0){
        from_info = parseFromSource(statement.from.source);
        table_info = global.hdb_schema[from_info.schema][from_info.table]
    } else {
        let from_clause = statement.from.map[from_level - 1];
        from_info = parseFromSource(from_clause.source);
        table_info = global.hdb_schema[from_info.schema][from_info.table];
        join = parseWhereClause(from_clause.constraint.on, table_info);
        join.type = from_clause.variant;
    }
    let search_object = {
        schema:from_info.schema,
        table:from_info.table,
        alias:from_info.alias
    };

    search_object.get_attributes = statement.result.map((column) => {
        let column_info = column.name.split('.');
        if(column_info.length > 1 && (column_info[0] === from_info.table || column_info[0] === from_info.alias)){
            return column_info[1];
        }
    });

    search_object.get_attributes = search_object.get_attributes.filter( Boolean );

    search_object.condition = parseWhereClause(statement.where ? statement.where[0] : null, table_info);
    return {
        table: search_object,
        join: join
    };
}

/*function parseFromClause(from){
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
}*/

function parseFromSource(source){
    let schema_table = source.name.split('.');
    return {
        schema: schema_table[0],
        table: schema_table[1],
        alias: source.alias
    };
}

function parseConstraint(constraint){
    let from_object = parseFromClause(constraint.source);
}

function parseWhereClause(where, table_info) {
    if(!where){
        return {
            attribute: table_info.hash_attribute,
            operation: '=',
            compare_value: '*'
        };
    }

    let condition_object = {};
    condition_object.operation = where.operation;
    condition_object.attribute = where.left.name;

    switch(where.operation){
        case '=':
            if(where.right.value) {
                condition_object.compare_value = where.right.value;
            } else {
                condition_object.compare_attribute = where.right.name;
            }
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