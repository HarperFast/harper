'use strict';
const fs = require('graceful-fs'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));
const base_path = hdb_properties.get('HDB_ROOT') + "/schema/"
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async'),
    path = require('path'),
    file_search = require('../lib/fileSystem/fileSearch'),
    _ = require('lodash'),
    joins = require('lodash-joins'),
    condition_patterns = require('../sqlTranslator/conditionPatterns');

const slash_regex =  /\//g;

// search by hash only
// what attributes are you selecting
// table selecting from
// table selecting from
// condition criteria

module.exports = {
    searchByHash: searchByHash,
    searchByValue:searchByValue,
    searchByHashes:searchByHashes,
    searchByConditions: searchByConditions,
    searchByJoinConditions: searchByJoinConditions
};

function searchByHash(search_object, callback){
    let hash_stripped = String(search_object.hash_value).replace(slash_regex, '').substring(0, 4000);
    let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
    async.waterfall([
        getAttributeFiles.bind(null, search_object.get_attributes, table_path, [hash_stripped]),
        consolidateData.bind(null, search_object.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function searchByHashes(search_object, callback){
    let validation_error = search_validator(search_object, 'hashes');
    if (validation_error) {
        callback(validation_error, null);
        return;
    }

    let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
    async.waterfall([
        getAttributeFiles.bind(null, search_object.get_attributes, table_path, search_object.hash_values),
        consolidateData.bind(null, search_object.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function searchByValue (search_object, callback) {
    let validation_error = search_validator(search_object, 'value');
    if (validation_error) {
        callback(validation_error);
        return;
    }

    let condition = {'like':[search_object.search_attribute, search_object.search_value]};
    let patterns = condition_patterns.createPatterns(condition, {name:search_object.table, schema:search_object.schema, hash_attribute:search_object.hash_attribute}, base_path);

    async.waterfall([
        //findFiles.bind(null, search_path, folder_pattern),
        file_search.findIDsByRegex.bind(null, patterns.folder_search_path, patterns.folder_search),
        getAttributeFiles.bind(null, search_object.get_attributes, patterns.table_path),
        consolidateData.bind(null, search_object.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function searchByConditions(search_wrapper, callback){
    let search_object = search_wrapper.tables[0];
    let validation_error = search_validator(search_object, 'conditions');
    if (validation_error) {
        callback(validation_error);
        return;
    }

    let table_schema = global.hdb_schema[search_object.schema][search_object.table];

    //let patterns = condition_patterns.createPatterns(search_object.condition, table_schema, base_path);
    let get_attributes = new Set();
    if(search_object.supplemental_fields && search_object.supplemental_fields.length > 0) {
        let all_attributes = search_object.get_attributes.concat(search_object.supplemental_fields);

        get_attributes = new Set(all_attributes);
    } else {
        get_attributes = new Set(search_object.get_attributes);
    }

    async.waterfall([
        //file_search.findIDsByRegex.bind(null, patterns.folder_search_path, patterns.folder_search),
        multiConditionSearch.bind(null, search_object.conditions, table_schema),
        getAttributeFiles.bind(null, get_attributes, `${base_path}${table_schema.schema}/${table_schema.name}/`),
        consolidateData.bind(null, table_schema.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function multiConditionSearch(conditions, table_schema, callback){
    let all_ids = [];

    async.forEachOf(conditions, (condition, key, caller) =>{
        all_ids[key] = {};
        let condition_key = Object.keys(condition)[0];
        if(condition_key  === 'and' || condition_key === 'or'){
            all_ids[key].operation = condition_key;
            condition = condition[condition_key];
        }

        let pattern = condition_patterns.createPatterns(condition, table_schema, base_path);

        file_search.findIDsByRegex(pattern.folder_search_path, pattern.folder_search, (err, results)=>{
            if(err) {
                console.error(err);
            } else {
                all_ids[key].ids = results;
            }
            caller();
        });
    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        let matched_ids = all_ids[0].ids;
        all_ids.shift();
        all_ids.forEach((ids)=>{
            if(!ids.operation || ids.operation === 'or'){
                matched_ids = matched_ids.concat(ids.ids);
            } else {
                matched_ids = _.intersection(matched_ids, ids.ids);
            }
        });
        if(matched_ids.length === 0){
            callback(null, matched_ids);
            return;
        }

        callback(null, _.uniq(matched_ids));
    });
}

function searchByJoinConditions(search_wrapper, callback){
    search_wrapper = addSupplementalFields(search_wrapper);
    search_wrapper = setAdditionalAttributeData(search_wrapper);

    searchByConditions(search_wrapper, (err, data)=>{
        if(err){
            callback(err);
            return;
        }

        let next_table = search_wrapper.tables[1];
        let join = search_wrapper.joins[0];

        next_table.conditions.push(convertJoinToCondition(search_wrapper.tables[0], search_wrapper.tables[1], join, data));


        searchByConditions({tables:[next_table]}, (err, data2)=> {
            if (err) {
                callback(err);
                return;
            }
            let comparators = Object.values(join)[0];
            let left_attribute_name = findAttribute(search_wrapper.all_get_attributes, comparators[0]);
            let right_attribute_name = findAttribute(search_wrapper.all_get_attributes, comparators[1]);

            let joined = joins.hashInnerJoin(data, (obj)=>{return obj[left_attribute_name.alias]}, data2, (obj)=>{return obj[right_attribute_name.alias]});
//TODO only do this part if there are supplemental fields
            let get_attributes = [];

            search_wrapper.tables.forEach((table)=>{
                table.get_attributes.forEach((attribute)=>{
                    get_attributes.push(attribute.alias);
                });
            });

            let results = [];
            joined.forEach((record)=>{
                results.push(_.pick(record, get_attributes));
            });

            results = sortData(results, search_wrapper);

            callback(null, results);
        });
    });
}

function setAdditionalAttributeData(search_wrapper){
    search_wrapper.all_get_attributes = [];

    search_wrapper.tables.forEach((table)=>{
        search_wrapper.all_get_attributes = search_wrapper.all_get_attributes.concat(table.supplemental_fields);
        table.get_attributes.forEach((attribute)=>{
            attribute.table = table.table;
            attribute.table_alias = table.alias;

            search_wrapper.all_get_attributes.push(attribute);
        });
    });

    return search_wrapper;
}

function sortData(data, search_wrapper){
    if(search_wrapper.order && search_wrapper.order.length > 0) {

        let columns = [];
        let orders = [];
        search_wrapper.order.forEach((order_by) => {
            let order_column = findAttribute(search_wrapper.all_get_attributes, order_by.attribute).alias;
            columns.push(order_column);
            orders.push(order_by.direction ? order_by.direction : 'asc');
        });

        return _.orderBy(data, columns, orders);
    }

    return data;
}

function addSupplementalFields(search_wrapper){
    if(search_wrapper.joins && search_wrapper.joins.length > 0) {
        search_wrapper.tables.forEach((table) => {
            table.supplemental_fields = [];
        });

        search_wrapper.joins.forEach((join) => {
            let comparators = Object.values(join)[0];

            let left_side = comparators[0].split('.');
            let right_side = comparators[1].split('.');

            search_wrapper.tables.forEach((table) => {
                if ((table.table === left_side[0] || table.alias === left_side[0])) {
                    table.supplemental_fields.push({
                        attribute: left_side[1],
                        alias: table.table + '.' + left_side[1],
                        table: table.table,
                        table_alias: table.alias
                    });
                } else if ((table.table === right_side[0] || table.alias === right_side[0])) {
                    table.supplemental_fields.push({
                        attribute: right_side[1],
                        alias: table.table + '.' + right_side[1],
                        table: table.table,
                        table_alias: table.alias
                    });
                }
            });
        });
    }

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
    let ids = Object.keys(attributes_data[hash_attribute] ? attributes_data[hash_attribute] : attributes_data[Object.keys(attributes_data)[0]]);

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
    async.each(hash_files, (file, caller)=>{
        fs.readFile(`${table_path}__hdb_hash/${attribute}/${file}.hdb`, (error, data)=>{
            if(error){
                if(error.code === 'ENOENT'){
                    caller(null, null);
                } else {
                    caller(error);
                }
                return;
            }

            attribute_data[file]=data.toString();
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