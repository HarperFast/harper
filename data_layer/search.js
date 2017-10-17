'use strict';
const fs = require('graceful-fs'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));
const base_path = hdb_properties.get('HDB_ROOT') + "/schema/"
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async'),
    winston = require('../utility/logging/winston_logger'),
    path = require('path'),
    file_search = require('../lib/fileSystem/fileSearch'),
    _ = require('lodash'),
    joins = require('lodash-joins'),
    condition_patterns = require('../sqlTranslator/conditionPatterns'),
    ConditionPatterns = require('../sqlTranslator/ConditionPatterns'),
    autocast = require('autocast'),
    math = require('mathjs'),
    aggregate_functions = require('../utility/functions/aggregateFunctions.json'),
    jinqjs = require('jinq');

math.import([
    require('../utility/functions/math/count'),
    require('../utility/functions/math/avg'),
    require('../utility/functions/date/dateFunctions')
]);

const slash_regex =  /\//g;
const calculation_regex = /\${(.*?)}/g;

module.exports = {
    searchByValue:searchByValue,
    searchByHash:searchByHash,
    searchByConditions: searchByConditions,
    search: search,
    multiConditionSearch: multiConditionSearch
};

function searchByHash(search_object, callback){
    try {
        let validation_error = search_validator(search_object, 'hashes');
        if (validation_error) {
            callback(validation_error, null);
            return;
        }

        if(search_object.schema !== 'system' && (!global.hdb_schema[search_object.schema] || !global.hdb_schema[search_object.schema][search_object.table])){
            return callback(`invalid table ${search_object.schema}.${search_object.table}`);
        }

        let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
        evaluateTableAttributes(search_object.get_attributes, search_object, (error, attributes) => {
            if (error) {
                callback(error);
                return;
            }

            let table_info = global.hdb_schema[search_object.schema][search_object.table];
            attributes = removeTableFromAttributeAlias(attributes, search_object.table);
            async.waterfall([
                getAttributeFiles.bind(null, attributes, table_path, search_object.hash_values),
                consolidateData.bind(null, table_info.hash_attribute)
            ], (error, data) => {
                if (error) {
                    callback(error);
                    return;
                }

                callback(null, data);
            });
        });
    } catch(e){
        callback(e);
    }
}

function removeTableFromAttributeAlias(attributes, table_name){
    attributes.forEach((attribute)=>{
        if(typeof attribute !== 'string') {
            attribute.alias = attribute.alias.replace(`${table_name}.`, '');
        }
    });

    return attributes;
}

function searchByValue (search_object, callback) {
    try {
        let validation_error = search_validator(search_object, 'value');
        if (validation_error) {
            callback(validation_error);
            return;
        }
        let operation = '=';
        if(search_object.search_value !== '*' && search_object.search_value !== '%' && (search_object.search_value.includes('*') || search_object.search_value.includes('%'))){
            operation = 'like';
        }
        let condition = {};
        condition[operation] = [search_object.search_attribute, search_object.search_value];

        let patterns = condition_patterns.createPatterns(condition, {
            name: search_object.table,
            schema: search_object.schema,
            hash_attribute: search_object.hash_attribute
        }, base_path);

        if(search_object.schema !== 'system' && (!global.hdb_schema[search_object.schema] || !global.hdb_schema[search_object.schema][search_object.table])){
            return callback(`invalid table ${search_object.schema}.${search_object.table}`);
        }

        evaluateTableAttributes(search_object.get_attributes, search_object, (err, attributes) => {
            if (err) {
                callback(err);
                return;
            }

            search_object.get_attributes = attributes;

            async.waterfall([
                file_search.findIDsByRegex.bind(null, patterns.folder_search_path, patterns.folder_search, patterns.blob_search),
                getAttributeFiles.bind(null, search_object.get_attributes, patterns.table_path),
                consolidateData.bind(null, search_object.hash_attribute)
            ], (error, data) => {
                if (error) {
                    callback(error);
                    return;
                }

                callback(null, data);
            });

        });


    } catch(e){
        callback(e);
    }
}

function searchByConditions(search_object, callback){
    try {
        let validation_error = search_validator(search_object, 'conditions');
        if (validation_error) {
            callback(validation_error);
            return;
        }

        if(search_object.schema !== 'system' && (!global.hdb_schema[search_object.schema] || !global.hdb_schema[search_object.schema][search_object.table])){
            return callback(`invalid table ${search_object.schema}.${search_object.table}`);
        }

        let table_schema = global.hdb_schema[search_object.schema][search_object.table];

        //let patterns = condition_patterns.createPatterns(search_object.condition, table_schema, base_path);
        let get_attributes = search_object.get_attributes;
        if (search_object.supplemental_fields && search_object.supplemental_fields.length > 0) {
            get_attributes = _.uniqBy(search_object.get_attributes.concat(search_object.supplemental_fields), 'alias');
        }
        evaluateTableAttributes(get_attributes, search_object, (err, attributes) => {
            if (err) {
                callback(err);
                return;
            }

            async.waterfall([
                multiConditionSearch.bind(null, search_object.conditions, table_schema),
                getAttributeFiles.bind(null, attributes, `${base_path}${table_schema.schema}/${table_schema.name}/`),
                consolidateData.bind(null, table_schema.hash_attribute)
            ], (error, data) => {
                if (error) {
                    callback(error);
                    return;
                }

                callback(null, data);
            });

        });
    } catch(e){
        callback(e);
    }

}

function multiConditionSearch(conditions, table_schema, callback){
    try {
        let all_ids = [];

        let patterns = new ConditionPatterns(conditions);
        patterns.parseConditions();

        async.forEachOf(patterns.column_conditions, (condition))

        async.forEachOf(conditions, (condition, key, caller) => {
            all_ids[key] = {};
            let condition_key = Object.keys(condition)[0];
            if (condition_key === 'and' || condition_key === 'or') {
                all_ids[key].operation = condition_key;
                condition = condition[condition_key];
            }


            let pattern = condition_patterns.createPatterns(condition, table_schema, base_path);

            file_search.findIDsByRegex(pattern.folder_search_path, pattern.folder_search, pattern.blob_search, (err, results) => {
                if (err) {
                    winston.error(err);
                } else {
                    all_ids[key].ids = results;
                }
                caller();
            });
        }, (err) => {
            if (err) {
                callback(err);
                return;
            }

            let matched_ids = all_ids[0].ids;
            all_ids.shift();
            all_ids.forEach((ids) => {
                if (!ids.operation || ids.operation === 'or') {
                    matched_ids = matched_ids.concat(ids.ids);
                } else {
                    matched_ids = _.intersection(matched_ids, ids.ids);
                }
            });
            if (matched_ids.length === 0) {
                callback(null, matched_ids);
                return;
            }

            callback(null, _.uniq(matched_ids));
        });
    } catch(e){
        callback(e);
    }
}

function search(search_wrapper, callback){
    try {
        //TODO add validation on search object

        getAsteriskFieldsForTables(search_wrapper, (error, search_wrapper) => {
            if(error){
                return callback(error);
            }
            search_wrapper = addSupplementalFields(search_wrapper);
            search_wrapper = setAdditionalAttributeData(search_wrapper);

            search_wrapper.tables.forEach((table) => {
                table.conditions = [];

                if(search_wrapper.conditions && search_wrapper.tables.length === 1){
                    table.conditions = search_wrapper.conditions;
                } else if(search_wrapper.conditions) {
                    search_wrapper.conditions.forEach((condition) => {
                        let condition_key = Object.keys(condition)[0];
                        let comparators = Object.values(condition[condition_key])[0];
                        let column = Object.values(comparators)[0].split('.');
                        if (search_wrapper.tables.length === 1 || table.table === column[0] || table.alias === column[0]) {
                            table.conditions.push(condition);
                        }
                    });
                }
                if(!table.conditions || table.conditions.length === 0){
                    table.conditions = [
                        {
                            'and':{
                                '=':[
                                    `${global.hdb_schema[table.schema][table.table].hash_attribute}`,
                                    '*'
                                ]
                            }
                        }
                    ];
                }
            });

            async.waterfall([
                fetchJoinData.bind(null, search_wrapper),
                processDataJoins.bind(null, search_wrapper),
                (data, caller)=>{
                    let results = groupData(data, search_wrapper);

                    let fields = procesSelects(search_wrapper.selects);

                    let query = new jinqjs()
                        .from(results);

                    if(search_wrapper.limit){
                        if(search_wrapper.limit.skip) {
                            query = query.skip(search_wrapper.limit.skip);
                        }

                        query = query.top(search_wrapper.limit.count);
                    }

                    let final_results;
                    try {
                        final_results = query.select(fields);
                    } catch(e){
                        return caller(e);
                    }

                    let order_fields = processOrderBy(search_wrapper);
                    if(order_fields && order_fields.length > 0){
                        final_results = new jinqjs()
                            .from(final_results)
                            .orderBy(order_fields)
                            .select();
                    }

                    caller(null, final_results);
                }
            ], (exception, results)=>{
                if(exception){
                    return callback(exception);
                }

                callback(null, results);
            });
        });
    } catch(e){
        callback(e);
    }
}

function procesSelects(selects){
    let fields = [];
    selects.forEach((select)=>{
        if(select.calculation && !select.is_aggregate){
            let calc_field = {
                text: select.alias,
                value:createMathPredicate(select)
            };
            fields.push(calc_field);
        } else {
            fields.push({text: select.alias, value:(row)=>{
                if(row[select.alias] === null || row[select.alias] === undefined){
                    return null;
                } else {
                    return row[select.alias];
                }

            }});
        }
    });

    return fields;
}

function createMathPredicate(calculation){
    return (row)=>{
        let code = math.compile(calculation.calculation);
        let scope ={};
        if(calculation.calculation_columns) {
            calculation.calculation_columns.forEach((column) => {
                scope[column.alias] = row[column.alias]
            });
        }

        try {
            return code.eval(scope);
        } catch(e){
            throw new Error(`Error in calculation: '${calculation.calculation}'. From row: ${JSON.stringify(row)}. error: ${e.message}`);
        }

    }
}

function processDataJoins(search_wrapper, search_data, callback){
    try {
        if (!search_data || search_data.length === 0) {
            return callback(null, []);
        }

        let results = search_data[0].data;
        //because we have processed the data in the order of the joins all we need to do is iterate thru the search_data array and tie the sets together according to the join
        for (let x = 1; x < search_data.length; x++) {
            let join = search_data[x].join;

            results = joinData(join, search_wrapper.all_get_attributes, results, search_data[x].data);
        }

        callback(null, results);
    } catch(e) {
        callback(e);
    }
}

function fetchJoinData(search_wrapper, callback){
    let search_data = [];

    async.eachOfLimit(search_wrapper.tables, 1, (table, index, call) => {
        let join = {};
        if(search_data.length > 0) {
            //evaluate join to find linked tables
            let join = table.join;
                let comparators = Object.values(join)[0];
                let first_attribute = findAttribute(search_wrapper.all_get_attributes, comparators[0]);
                let second_attribute = findAttribute(search_wrapper.all_get_attributes, comparators[1]);

                //find primary table to get data from & create condition
                let primary_table_data = {};
                search_data.forEach((the_data) => {
                    if (the_data.table.table === first_attribute.table || the_data.table.alias === first_attribute.table_alias ||
                        the_data.table.table === second_attribute.table || the_data.table.alias === second_attribute.table_alias) {
                        primary_table_data = the_data;
                        return;
                    }
                });

                //convert the join to a condition and add to the secondary table
                table.conditions.push(convertJoinToCondition(primary_table_data.table, table, join, primary_table_data.data));

        }
        //fetch the data
        searchByConditions(table, (error, results) => {
            if (error) {
                return call(error);
            }

            search_data.push({table: table, data: results, join: table.join});
            call();
        });
    }, (err) => {
        if(err){
            return callback(err);
        }

        return callback(null, search_data);
    });
}

function joinData(join, all_get_attributes, data, data2){
    let comparators = Object.values(join)[0];
    let left_attribute_name = findAttribute(all_get_attributes, comparators[0]);
    let right_attribute_name = findAttribute(all_get_attributes, comparators[1]);

    let join_function;
    switch(join.type){
        case 'join':
        case 'inner join':
            join_function = joins.hashInnerJoin;
            break;
        case 'left join':
        case 'left outer join':
            join_function = joins.hashLeftOuterJoin;
            break;
        default:
            join_function = joins.hashInnerJoin;
            break;
    }

    let joined = join_function(data, (obj) => {
        return obj[left_attribute_name.alias]
    }, data2, (obj) => {
        return obj[right_attribute_name.alias]
    });

    return joined;
}

function getAsteriskFieldsForTables(search_wrapper, callback){
    let tables = [];
    let asterisk_columns = search_wrapper.selects.filter((column)=>{
        return column.attribute === '*';
    });

    let asterisk_map = group(asterisk_columns, ['table']);

    async.eachLimit(search_wrapper.tables, 1, (table, caller)=>{
        if(asterisk_map[table.table]) {
            getAllAttributeNames(table, (err, attributes)=>{
                if(err){
                    callback(err);
                    return;
                }

                search_wrapper.selects = search_wrapper.selects.concat(attributes);

                caller();
            });

        }else {
            caller();
        }
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        search_wrapper.selects = search_wrapper.selects.filter((column)=>{
            return column.attribute !== '*';
        });

        callback(null, search_wrapper);
    });
}

function setAdditionalAttributeData(search_wrapper){
    search_wrapper.all_get_attributes = [];

    search_wrapper.tables.forEach((table)=>{
        if(table.supplemental_fields) {
            search_wrapper.all_get_attributes = search_wrapper.all_get_attributes.concat(table.supplemental_fields);
        }
        table.get_attributes.forEach((attribute)=>{
            attribute.table = table.table;
            attribute.table_alias = table.alias;

            search_wrapper.all_get_attributes.push(attribute);
        });
    });

    search_wrapper.all_get_attributes = _.uniqBy(search_wrapper.all_get_attributes, (item)=>{
        return[item.table, item.attribute].join();
    });


    return search_wrapper;
}

function processOrderBy(search_wrapper){
    let orders = [];
    if(search_wrapper.order && search_wrapper.order.length > 0) {
        search_wrapper.order.forEach((order_by) => {
            let order_attribute = findAttribute(search_wrapper.all_get_attributes, order_by.table + '.' + order_by.attribute);
            if(!order_attribute){
                order_attribute = search_wrapper.selects.filter((select)=>{
                    return select.alias = order_by.attribute;
                })[0];
            }

            if(order_attribute) {
                let order_column = order_attribute.alias;
                orders.push({
                    field: order_column,
                    sort: order_by.direction ? order_by.direction : 'asc'
                });
            }
        });

        return orders;
    }

    return orders;
}

function groupData(data, search_wrapper){
    if(!data || data.length === 0){
        return [];
    }

    let aggregate_calculations = search_wrapper.selects.filter((select)=>{
        return select.is_aggregate;
    });

    if(search_wrapper.group && search_wrapper.group.length > 0) {

        let columns = [];
        //let orders = [];
        search_wrapper.group.forEach((group_by) => {
            let group_attribute = findAttribute(search_wrapper.all_get_attributes, group_by.attribute);
            if(group_attribute) {
                columns.push(group_attribute.alias);
            }
        });

        if(columns) {
            //create grouping
            let groups = group(data, columns);

            //get the nested array results inside each group
            let results = walkGroupTree(groups, aggregate_calculations, columns);

            return results;
        }

        return data;
    } else if(aggregate_calculations && aggregate_calculations.length > 0) {

        let results = walkGroupTree(data, aggregate_calculations, []);

        return results;
    } else {
        return data;
    }
}

function aggregateData(data, calculations){

    if(calculations && calculations.length > 0) {
        let aggregate_object = {};
        let expressions = [];
        let result_object = {};
        calculations.forEach((calculation) => {
            expressions.push(calculation.calculation.replace(/\./g,'_'));
            calculation.calculation_columns.forEach((column) => {
                aggregate_object[column.alias] = [];
            });
        });

        let aggregate_columns = Object.keys(aggregate_object);
        data.forEach((record) => {
            aggregate_columns.forEach((column) => {
                if(record[column] !== null && record[column] !== undefined) {
                    aggregate_object[column].push(record[column]);
                }
            });
        });

        let compiled_expressions = math.compile(expressions);
        compiled_expressions.forEach((expression, x) => {
            let scope = {};
            calculations[x].calculation_columns.forEach((column) => {
                scope[column.alias] = aggregate_object[column.alias];

            });

            result_object[calculations[x].alias] = expression.eval(scope);
        });
        return result_object;
    }
    return null;
}

function group(collection, keys) {
    if (!keys.length) {
        return collection;
    }
    else {
        return _(collection).groupBy(keys[0]).mapValues(function(values) {
            return group(values, keys.slice(1));
        }).value();
    }
}


//take the data set and reduce the set to unique by the defined group columns or just the aggregate results
function uniqueGroupResults(data, aggregate_results, group_columns){
    if(!group_columns || group_columns.length === 0){
        return [aggregate_results];
    }
    let results = _.uniqBy(data, (item) => {
        if(aggregate_results) {
            item = _.merge(item, aggregate_results);
        }
        let item_array = [];
        group_columns.forEach((column) => {
            item_array.push(item[column]);
        });
        return item_array.join();
    });

    return results;
}

//recursively walks the group tree and performs aggregate calcs (if needed) and returns the unique set
function walkGroupTree(the_object, calculations, group_columns){
    var result = [];

    if(the_object instanceof Array){
        let aggregate_results = aggregateData(the_object, calculations);
        let results = uniqueGroupResults(the_object, aggregate_results, group_columns);
        return results;
    }

    Object.keys(the_object).sort().forEach((prop)=>{
        result =  result.concat(walkGroupTree(the_object[prop], calculations, group_columns));
    });

    return result;
}

function createJoinMap(tables){
    let joins = {};
    tables.forEach((table)=>{
        if(table.join && Object.values(table.join).length > 0){
            let comparators = Object.values(table.join)[0];
            let left_side = comparators[0].split('.');
            let right_side = comparators[1].split('.');
            if(!joins[left_side[0]])
            {
                joins[left_side[0]] = [];
            }

            if(!joins[right_side[0]])
            {
                joins[right_side[0]] = [];
            }

            joins[right_side[0]].push({
                attribute: right_side[1],
                alias: right_side[1]
            });

            joins[left_side[0]].push({
                attribute: left_side[1],
                alias: left_side[1]
            });
        }
    });

    return joins;
}

function parseCalculation(calculation){
    let skip_node = false;
    let columns = [];
    let is_aggregate = false;

    let nodes = math.parse(calculation);
    nodes.filter((node)=>{
        //if the calculation contains an aggregate function mark is as an aggregate for appropriate processing
        if(node.isFunctionNode){
            if(aggregate_functions.indexOf(node.fn.name) >= 0) {
                is_aggregate = true;
            }
        } else if(!node.isIndexNode && node.object && node.index && node.index.dotNotation){
            let table = node.object.name;
            let attribute = node.index.dimensions[0].value;
            columns.push({
                table : table,
                attribute: attribute,
                alias: `${table}_${attribute}`
            });
            skip_node = true;
            return node;
        } else if(node.isSymbolNode && skip_node){
            skip_node = false;
        } else if(node.isSymbolNode){
            columns.push({
                attribute: node.name,
                alias: node.name
            });
            return node;
        }
    });

    return {columns: columns, is_aggregate: is_aggregate};
}



function addSupplementalFields(search_wrapper){
    let calculation_columns = [];
    search_wrapper.selects.forEach((select)=>{
        if(select.calculation){
            //we use math.parse to return the elements that are the columns
            if(!select.alias){
                select.alias = select.calculation;
            }

            if(select.calculation.indexOf('*') > -1){
                let first_table = search_wrapper.tables[0];
                let hash_attribute = global.hdb_schema[first_table.schema][first_table.table].hash_attribute;
                select.calculation = select.calculation.replace(/\*/g, `${first_table.table}.${hash_attribute}`);
            }

            let parse_results = parseCalculation(select.calculation);
            select.calculation_columns = parse_results.columns;
            select.is_aggregate = parse_results.is_aggregate;
            calculation_columns = calculation_columns.concat(select.calculation_columns);

        }
    });

    let columns = search_wrapper.selects.filter((column)=>{
        return column.attribute;
    });
    let attribute_map = group(columns, ['table']);

    let group_map = group(search_wrapper.group, ['table']);

    let joins = createJoinMap(search_wrapper.tables);

    search_wrapper.tables.forEach((table)=>{
        table.supplemental_fields = [];
        if(attribute_map[table.table]){
            table.get_attributes = attribute_map[table.table];
        }

        if(table.alias && attribute_map[table.alias]){
            table.get_attributes = table.get_attributes.concat(attribute_map[table.alias]);
        }

        if(group_map && group_map[table.table]){
            group_map[table.table].forEach((group_column)=>{
                table.supplemental_fields.push({
                    attribute: group_column.attribute,
                    alias: group_column.attribute,
                    table: table.table,
                    table_alias: table.alias
                });
            });
        }

        if(calculation_columns) {
            calculation_columns.forEach((calc_column) => {
                if (search_wrapper.tables.length === 1 || table.table === calc_column.table || table.alias === calc_column.table) {
                    table.supplemental_fields.push({
                        attribute: calc_column.attribute,
                        alias: calc_column.alias,
                        table: table.table,
                        table_alias: table.alias
                    });
                }
            });
        }


        let join_list = joins[table.table] ? joins[table.table] : joins[table.alias];
        if(join_list){
            join_list.forEach((join)=>{
                join.table = table.table;
                join.table_alias = table.alias;
                table.supplemental_fields.push(join);
            });
        }

        table.get_attributes = _.uniqBy(table.get_attributes, 'attribute');
        table.supplemental_fields = _.uniqBy(table.supplemental_fields, 'alias');
    });

    return search_wrapper;
}

function convertJoinToCondition(left_table, right_table, join, data){
    let condition_attribute;
    let comparators = Object.values(join)[0];
    let all_attributes = [].concat(left_table.get_attributes, left_table.supplemental_fields, right_table.get_attributes, right_table.supplemental_fields);
    let left_attribute = findAttribute(all_attributes, comparators[0]);
    let right_attribute = findAttribute(all_attributes, comparators[1]);
    let data_attribute;
    //the left_table is always the table with the data we need to get the values from, the right table is the one being joined to
    // however the order of the join clause could be reversed because people be crazy so we need to figure it out
    if(left_attribute.alias === right_table.alias || left_attribute.table === right_table.table){
        condition_attribute = left_attribute.attribute;
        data_attribute = right_attribute.alias;
    } else if(right_attribute.alias === right_table.alias || right_attribute.table === right_table.table){
        condition_attribute = right_attribute.attribute;
        data_attribute = left_attribute.alias;
    }

    let condition_values = data.map((row)=> {
        return row[data_attribute];
    });

    return {
        'and': {
            'in': [condition_attribute, condition_values]
        }
    };
}

function findAttribute(all_attributes, raw_column){
    let table_column = raw_column.split('.');

    return _.filter(all_attributes, (attribute)=> {
        if (table_column.length === 1) {
            return attribute.alias === table_column[0];
        }

        return (attribute.table === table_column[0] || attribute.table_alias === table_column[0]) && (attribute.attribute === table_column[1]);
    })[0];
}

RegExp.escape= function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

function consolidateData(hash_attribute, attributes_data, callback){
    let data_array = [];
    let data_keys = Object.keys(attributes_data);

    if(!attributes_data || data_keys.length === 0) {
        return callback(null, data_array);
    }

    let ids;
    if(attributes_data[hash_attribute]){
        ids = Object.keys(attributes_data[hash_attribute]);
    } else {
        Object.keys(attributes_data).forEach((key)=>{
            let split_key = key.split('.');
            if(split_key.length > 1 && split_key[1] === hash_attribute){
                ids = Object.keys(attributes_data[key]);
            }
        });
    }

    if(!ids) {
        ids = Object.keys(attributes_data[Object.keys(attributes_data)[0]]);
    }

    ids.forEach(function(key){
        let data_object = {};

        data_keys.forEach(function(attribute){
            data_object[attribute] = attributes_data[attribute][key];
        });
        data_array.push(data_object);
    });
    callback(null, data_array);
}

function getAttributeFiles(get_attributes, table_path, hash_files, callback){
    let attributes_data = {};
    async.each(get_attributes, (attribute, caller)=>{
        //evaluate if an array of strings or objects has been passed in and assign values accordingly
        let attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
        let alias_name = (typeof attribute === 'string') ? attribute :
            (attribute.alias ? attribute.alias : attribute.name);
        readAttributeFiles(table_path, attribute_name, hash_files, (err, results)=>{
            if(err){
                caller(err);
                return;
            }

            attributes_data[alias_name]=results;
            caller();
        });
    }, (error)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, attributes_data);
    });
}

function readAttributeFiles(table_path, attribute, hash_files, callback){
    let attribute_data = {};
    async.eachLimit(hash_files, 1000, (file, caller)=>{
        fs.readFile(`${table_path}__hdb_hash/${attribute}/${file}.hdb`, 'utf-8', (error, data)=>{
            if(error){
                if(error.code === 'ENOENT'){
                    caller(null, null);
                } else {
                    caller(error);
                }
                return;
            }

            let value = autocast(data.toString());
            //autocast is unable to convert string to object/array so we need to figure it out
            if(typeof value === 'string'){
                if((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))){
                    try{
                        value = JSON.parse(value);
                    }catch(e){
                    }
                }
            }

            attribute_data[file]=value;
            caller();
        });
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        callback(null, attribute_data);
    });
}

function evaluateTableAttributes(get_attributes, table_info, callback){
    let star_attribute =  _.filter(get_attributes, (attribute)=> {
        return attribute === '*' || attribute.attribute === '*';
    });

    if(star_attribute && star_attribute.length > 0){
        getAllAttributeNames(table_info, (err, attributes)=>{
            if(err){
                callback(err);
                return;
            }
            get_attributes = _.filter(get_attributes, (attribute)=>{
                return attribute !== '*' && attribute.attribute !== '*';
            });

            attributes.forEach((attribute)=>{
                get_attributes.push(attribute);
            });

            callback(null, _.uniqBy(get_attributes, 'alias'));
        });
    }else {
        callback(null, get_attributes);
    }
}

function getAllAttributeNames(table_info, callback){
    let search_path = `${base_path}${table_info.schema}/${table_info.table}/__hdb_hash/`;

    file_search.findDirectoriesByRegex(search_path, /.*/, (err, folders)=>{
        if(err){
            callback(err);
            return;
        }

        let attributes = [];
        folders.forEach((folder)=>{
            attributes.push({
                attribute:folder,
                alias: folder,
                table:table_info.table,
                table_alias:table_info.alias ? table_info.alias : table_info.table
            });
        });

        callback(null, attributes);
    });
}