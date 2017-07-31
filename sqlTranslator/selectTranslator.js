const search = require('../data_layer/search').search,
    global_schema = require('../utility/globalSchema'),
    async = require('async'),
    condition_parser = require('./conditionParser'),
    select_validator = require('./selectValidator').validator;


module.exports = {
    convertSelect:convertSelect
};

function convertSelect(statement, callback) {
    try {


        select_validator(statement, (err)=> {
            if(err){
                callback(err);
                return;
            }

            let converter_function;
            if (statement.from.type === 'identifier') {
                converter_function = generateBasicSearchObject;
            } else {
                converter_function = generateAdvancedSearchObject;
            }

            async.waterfall([
                converter_function.bind(null, statement),
                search
            ], (err, results) => {
                if (err) {
                    callback(err);
                    return;
                }

                callback(null, results);
            });
        });
    } catch(e) {
        callback(e);
    }
}

function generateBasicSearchObject(statement, callback){
    let schema_table = statement.from.name.split('.');
    global_schema.getTableSchema(schema_table[0], schema_table[1], (err, table_info)=> {
        if (err) {
            callback(err);
            return;
        }


        let search_object = {
            schema: schema_table[0],
            table: schema_table[1]
        };

        search_object.get_attributes = statement.result.map((column) => {
            let column_info = column.name.split('.');
            let column_name = column_info.length === 1 ? column_info[0] : column_info[1];

            return {
                attribute: column_name,
                alias: column.alias ? column.alias : column_name
            };
        });

        search_object.conditions = condition_parser.parseConditions(statement.where, table_info);

        callback(null, {tables: [search_object]});
    });
}

function generateAdvancedSearchObject(statement, callback){
    try {
        let search_wrapper = {tables: [], joins: []};
        let times = statement.from.map ? statement.from.map.length + 1 : 1;
        async.times(times, (x, callback)=>{
            generateObject(statement, x, (error, search)=>{
                if(error){
                    callback(error);
                    return;
                }

                search_wrapper.tables[x] = search.table;
                if (Object.keys(search.join).length > 0) {
                    search_wrapper.joins.push(search.join);
                }

                callback();
            });
        }, (err)=>{
            if(err){
                callback(err);
                return;
            }
            search_wrapper.order = parseOrderby(statement.order);
            callback(null, search_wrapper);
        });
    } catch(e) {
        throw e;
    }
}

function parseOrderby(order_by_clause){
    let order = [];
    if(order_by_clause) {
        order_by_clause.forEach((order_by) => {
            order.push({
                attribute: order_by.expression ? order_by.expression.name : order_by.name,
                direction: order_by.direction ? order_by.direction : 'asc'
            });
        });
    }
    
    return order;
}

function generateObject(statement, from_level, callback){
    let from_info = {};
    let join = {};
    if(from_level === 0){
        from_info = parseFromSource(statement.from.source ? statement.from.source : statement.from);
    } else {
        let from_clause = statement.from.map[from_level - 1];
        from_info = parseFromSource(from_clause.source);
        join = condition_parser.parseWhereClause(from_clause.constraint.on);
        join.type = from_clause.variant;
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
                alias: column.alias ? column.alias : column_info[1]
            };
        }
    });

    search_object.get_attributes = search_object.get_attributes.filter( Boolean );

    global_schema.getTableSchema(from_info.schema, from_info.table, (err, table_info)=>{
        if(err){
            callback(err);
            return;
        }

        table_info.alias = from_info.alias;
        search_object.conditions = condition_parser.parseConditions(statement.where, table_info);

        callback(null, {
            table: search_object,
            join: join
        });
    });
}

function parseFromSource(source){
    let schema_table = source.name.split('.');
    return {
        schema: schema_table[0],
        table: schema_table[1],
        alias: source.alias
    };
}

