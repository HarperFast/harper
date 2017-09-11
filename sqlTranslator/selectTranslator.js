const search = require('../data_layer/search').search,
    global_schema = require('../utility/globalSchema'),
    async = require('async'),
    condition_parser = require('./conditionParser'),
    select_validator = require('./selectValidator').validator,
    _=require('lodash'),
    AttributeParser = require('./AttributeParser');


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
            selects:[],
            tables:[{
                schema: schema_table[0],
                table: schema_table[1],
                join:{}
            }],
            conditions:[],
            group:[],
            order:[],
        };

        let attribute_parser = new AttributeParser(statement.result, search_object.tables);
        search_object.selects = attribute_parser.parseGetAttributes();

        search_object.conditions = condition_parser.parseConditions(statement.where);
        search_object.order = parseOrderby(search_object.tables, statement.order);
        search_object.group = parseGroupby(search_object.tables, statement.group);
        callback(null, search_object);
    });
}

function generateAdvancedSearchObject(statement, callback){
    try {
        let search_wrapper = {
            selects:[],
            tables: [],
            conditions:[],
            group:[],
            order:[]
        };



        let times = statement.from.map ? statement.from.map.length + 1 : 1;
        async.times(times, (x, caller)=>{
            let table = parseFromClause(statement.from, x);
            search_wrapper.tables.push(table);
            caller();
        }, (err)=>{
            if(err){
                callback(err);
                return;
            }

            let attribute_parser = new AttributeParser(statement.result, search_wrapper.tables);
            search_wrapper.selects = attribute_parser.parseGetAttributes();

            search_wrapper.conditions = condition_parser.parseConditions(statement.where);
            search_wrapper.order = parseOrderby(search_wrapper.tables, statement.order);
            search_wrapper.group = parseGroupby(search_wrapper.tables, statement.group);
            callback(null, search_wrapper);
        });
    } catch(e) {
        throw e;
    }
}

function parseOrderby(tables, order_by_clause){
    let order = [];
    if(order_by_clause) {
        order_by_clause.forEach((order_by) => {
            let order_object = createGroupOrderObject(tables, order_by);
            order_object.direction = order_by.direction ? order_by.direction : 'asc';

            order.push(order_object);
        });
    }
    
    return _.uniq(order);
}

function parseGroupby(tables, group_by_clause){
    let group = [];
    if(group_by_clause) {
        group_by_clause.expression.forEach((group_by) => {
            group.push(createGroupOrderObject(tables, group_by));
        });
    }

    return _.uniq(group);
}

function createGroupOrderObject(tables, clause){
    let table_name = null;

    let group_by_split = (clause.expression ? clause.expression.name : clause.name).split('.');

    if(tables.length === 1){
        table_name = tables[0].table;
    } else if(group_by_split.length > 1){
        table_name = _.filter(tables, (table)=>{
            return table.table === group_by_split[0] || table.alias === group_by_split[0];
        })[0];
    }

    return {
        table:table_name,
        attribute: group_by_split.length === 1 ? group_by_split[0] : group_by_split[1]
    };
}

function parseFromClause(from, from_level){
    let from_info = {};
    let join = {};
    if(from_level === 0){
        from_info = parseFromSource(from.source ? from.source : from);
    } else {
        let from_clause = from.map[from_level - 1];
        from_info = parseFromSource(from_clause.source);
        join = condition_parser.parseWhereClause(from_clause.constraint.on);
        join.type = from_clause.variant;
    }
    let table = {
        schema:from_info.schema,
        table:from_info.table,
        alias:from_info.alias,
        supplemental_fields: [],
        get_attributes: [],
        join:join
    };

    return table;
}

function parseFromSource(source){
    let schema_table = source.name.split('.');
    return {
        schema: schema_table[0],
        table: schema_table[1],
        alias: source.alias
    };
}

