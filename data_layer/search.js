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
    autocast = require('autocast');

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

        let condition = {'=': [search_object.search_attribute, search_object.search_value]};
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
            get_attributes = _.uniqBy(search_object.get_attributes.concat(search_object.supplemental_fields), 'attribute');
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

            let get_attributes = [];

            search_wrapper.tables.forEach((table) => {
                table.conditions = [];
                table.get_attributes.forEach((attribute) => {
                    get_attributes.push(attribute.alias);
                });

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
            });

            async.waterfall([
                fetchJoinData.bind(null, search_wrapper),
                processDataJoins.bind(null, search_wrapper),
                (data, caller)=>{
                    let results = [];
                    data.forEach((record) => {
                        results.push(_.pick(record, get_attributes));
                    });

                    results = groupData(results, search_wrapper);

                    results = sortData(results, search_wrapper);

                    caller(null, results);
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

function sortData(data, search_wrapper){
    if(search_wrapper.order && search_wrapper.order.length > 0) {

        let columns = [];
        let orders = [];
        search_wrapper.order.forEach((order_by) => {
            let order_attribute = findAttribute(search_wrapper.all_get_attributes, order_by.table + '.' + order_by.attribute);
            if(order_attribute) {
                let order_column = order_attribute.alias;
                columns.push(order_column);
                orders.push(order_by.direction ? order_by.direction : 'asc');
            }
        });

        if(orders) {
            return _.orderBy(data, columns, orders);
        }

        return data;
    }

    return data;
}

function groupData(data, search_wrapper){
    if(search_wrapper.group && search_wrapper.group.length > 0) {

        let columns = [];
        //let orders = [];
        search_wrapper.group.forEach((group_by) => {
            let group_attribute = findAttribute(search_wrapper.all_get_attributes, group_by.attribute);
            if(group_attribute) {
                let order_column = group_attribute.alias;
                columns.push(order_column);
            }
        });

        if(columns) {
            //create grouping
            let groups = group(data, columns);

            //get the nested array results inside each group
            let results = walkGroupTree(groups);

            //get distinct values
            results = _.uniqBy(results, (item)=>{
                let item_array = [];
                columns.forEach((column)=>{
                    item_array.push(item[column]);
                });
                return item_array.join();
            } );

            return results;
        }

        return data;
    }

    return data;
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

function walkGroupTree(the_object){
    var result = [];

    if(the_object instanceof Array){
        return the_object;
    }

    Object.keys(the_object).sort().forEach((prop)=>{
        result =  result.concat(walkGroupTree(the_object[prop]));
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

function addSupplementalFields(search_wrapper){
    let calculation_columns = search_wrapper.selects.forEach((select)=>{
        if(select.calculation){
            let calc_columns = calc.calculation.match(calculation_regex);
            if(calc_columns){
                calc_columns.forEach((calc)=>{
                    return calc.replace('${').replace('}');
                });
            }
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
                let column_split = calc_column.split('.');
                if (search_wrapper.tables.length === 1 || table.table === column_split[0] || table.alias === column_split[0]) {
                    table.supplemental_fields.push({
                        attribute: column_split.length === 1 ? column_split[0] : column_split[1],
                        alias: column_split.length === 1 ? column_split[0] : column_split[1],
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
        table.supplemental_fields = _.uniqBy(table.supplemental_fields, 'attribute');
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
        fs.readFile(`${table_path}__hdb_hash/${attribute}/${file}.hdb`, (error, data)=>{
            if(error){
                if(error.code === 'ENOENT'){
                    caller(null, null);
                } else {
                    caller(error);
                }
                return;
            }

            attribute_data[file]=autocast(data.toString());
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