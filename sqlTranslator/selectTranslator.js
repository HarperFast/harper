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

    search_wrapper.order = parseOrderby(statement.order);
    
    return search_wrapper;
}

function parseOrderby(order_by_clause){
    let order = [];
    
    order_by_clause.forEach((order_by)=>{
        order.push({
            attribute:order_by.expression ? order_by.expression.name : order_by.name,
            direction: order_by.direction ? order_by.direction : 'asc'
        });
    });
    
    return order;
}

function generateObject(statement, from_level){
    let from_info = {};
    let join = {};
    if(from_level === 0){
        from_info = parseFromSource(statement.from.source);
    } else {
        let from_clause = statement.from.map[from_level - 1];
        from_info = parseFromSource(from_clause.source);
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

    search_object.conditions = parseConditions(statement.where, from_info);

    return {
        table: search_object,
        join: join
    };
}

function parseFromSource(source){
    let schema_table = source.name.split('.');
    return {
        schema: schema_table[0],
        table: schema_table[1],
        alias: source.alias
    };
}

function parseConditions(where_clause, table_info){
    if(!where_clause){
        return {
            '=' : [`${table_info.hash_attribute}`, '*']
        };
    }

    let conditions = [];
    let left = where_clause[0];

/*
    if(conditionTableMatch(where_clause[0].right, table_info)) {
        conditions.push(createConditionObject(where_clause[0].operation, where_clause[0].right));
    }
*/

    while(left.type === 'expression' && left.right.type === 'expression'){
        if(conditionTableMatch(left.right, table_info)) {
            conditions.push(createConditionObject(left.operation, left.right));
        }
        left = left.left;
    }

    if(conditionTableMatch(left, table_info)) {
        conditions.push(createConditionObject('and', left));
    }

    return conditions
}

function conditionTableMatch(condition, table_info){
    let column_info = condition.left.name.split('.');
    return column_info.length === 1 || (column_info.length > 1 && (column_info[0] === table_info.table || column_info[0] === table_info.alias));
}

function createConditionObject(operation, condition){
    let condition_object = {};
    if(operation) {
        condition_object[operation] = parseWhereClause(condition);
    } else{
        condition_object = parseWhereClause(condition);
    }
    return condition_object;
}

function parseWhereClause(where) {


    let condition_object = {};
    condition_object[where.operation] = [];
    condition_object[where.operation].push(`${where.left.name}`);

    switch(where.operation){
        case '=':
        case 'like':
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