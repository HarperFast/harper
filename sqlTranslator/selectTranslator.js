const search = require('../data_layer/search'),
    searchByConditions = search.searchByConditions,
    searchByJoinConditions = search.searchByJoinConditions;


module.exports = {
    convertSelect:convertSelect
};

function convertSelect(statement, callback) {
    let final_search_object = {};
    let search_function;
    if(statement.from.type === 'identifier') {
        final_search_object = {
            tables:[
                generateBasicSearchObject(statement)
            ]
        };
        search_function = searchByConditions;
    } else {
        final_search_object = generateAdvancedSearchObject(statement);
        search_function = searchByJoinConditions;
    }

    search_function(final_search_object, (err, results)=>{
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
        if(Object.keys(search.join).length > 0){
            search_wrapper.joins.push(search.join);
        }
    }
//TODO fix this!
    //search_wrapper = addSupplementalFields(search_wrapper);

    return search_wrapper;
}

function addSupplementalFields(search_wrapper){
    search_wrapper.joins.forEach((join)=>{


        let join_info = join.attribute.split('.');
        let join_to_info = join.compare_attribute.split('.');
        search_wrapper.tables.forEach((table)=>{
            if((table.table === join.left_table || table.alias === v) && table.get_attributes.indexOf(join.left_table) < 0){
                table.supplemental_fields.push(join_info[1]);
            } else if((table.table === join_to_info[0] || table.alias === join_to_info[0])  && table.get_attributes.indexOf(join_to_info[1]) < 0){
                table.supplemental_fields.push(join_to_info[1]);
            }
        });
    });

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
    }
    let search_object = {
        schema:from_info.schema,
        table:from_info.table,
        alias:from_info.alias,
        supplemental_fields: []
    };

    search_object.get_attributes = statement.result.map((column) => {
        let column_info = column.name.split('.');
        if(column_info.length > 1 && (column_info[0] === from_info.table || column_info[0] === from_info.alias)){
            return {
                attribute: column_info[1],
                alias: column.alias ? column.alias : from_info.table + '.' + column_info[1]
            };
        }
    });

    search_object.get_attributes = search_object.get_attributes.filter( Boolean );

    search_object.condition = parseWhereClause(statement.where ? statement.where[0] : null, table_info);
    return {
        table: search_object,
        join: join
    };
}
/*
function createJoinObject(from_clause, table_info){
    let join = parseWhereClause(from_clause.constraint.on, table_info);
    join.type = from_clause.variant;

    let left_split = join.attribute.split('.');
    let right_split = join.compare_attribute.split('.');

    join.left_table = left_split[0];
    join.left_attribute = left_split[1];

    join.right_table = right_split[0];
    join.right_attribute = right_split[1];

    delete join.attribute;
    delete join.compare_attribute;

    return join;
}*/

function parseFromSource(source){
    let schema_table = source.name.split('.');
    return {
        schema: schema_table[0],
        table: schema_table[1],
        alias: source.alias
    };
}

function parseWhereClause(where, table_info) {
    if(!where){
        return {
            '=' : [`${table_info.hash_attribute}`, '*']
        };
    }

    let condition_object = {};
    condition_object[where.operation] = [];
    condition_object[where.operation].push(`${where.left.name}`);

    switch(where.operation){
        case '=':
            if(where.right.value) {
                condition_object[where.operation].push(where.right.value);
            } else {
                condition_object[where.operation].push(`${where.right.name}`);
            }
            break;
        case 'in':
            let compare_value = [];
            where.right.expression.forEach((value_object)=>{
                compare_value.push(value_object.value);
            });
            condition_object[where.operation].push(compare_value);
            break;
        default:
            break;
    }

    return condition_object;
}