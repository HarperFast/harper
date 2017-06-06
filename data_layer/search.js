'use strict';
const fs = require('fs')
    , settings = require('settings')
    , base_path = settings.HDB_ROOT + "/schema/"
    , search_validator = require('../validation/searchValidator.js')
    , async = require('async'),
    path = require('path'),
    globby = require('globby'),
    _ = require('lodash'),
    joins = require('lodash-joins');

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

    let search_string = String(search_object.search_value).replace(slash_regex, '').substring(0, 4000);
    let folder_pattern = search_string === '*' ? '*.hdb' : `*${search_string}*/*.hdb`;
    let file_pattern = search_string === '*' ? '*' : new RegExp(search_object.search_value);
    let table_path = `${base_path}${search_object.schema}/${search_object.table}/`;
    let search_path = search_object.search_attribute === search_object.hash_attribute ? `${table_path + '__hdb_hash/' + search_object.search_attribute}/` :
        `${table_path + search_object.search_attribute}/`;

    async.waterfall([
        findFiles.bind(null, search_path, folder_pattern),
        //verifyFileMatches.bind(null, file_pattern, `${table_path}/__hdb_hash/${search_object.search_attribute}/`),
        getAttributeFiles.bind(null, search_object.get_attributes, table_path),
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

    let patterns = createPatterns(search_object.condition, table_schema);
    let get_attributes = new Set();
    if(search_object.supplemental_fields && search_object.supplemental_fields.length > 0) {
        let all_attributes = search_object.get_attributes.concat(search_object.supplemental_fields);

        get_attributes = new Set(all_attributes);
    } else {
        get_attributes = new Set(search_object.get_attributes);
    }

    async.waterfall([
        findFiles.bind(null, patterns.folder_search_path, patterns.folder_search),
        //verifyFileMatches.bind(null, patterns.file_search, patterns.hash_path),
        getAttributeFiles.bind(null, get_attributes, patterns.table_path),
        consolidateData.bind(null, table_schema.hash_attribute)
    ], (error, data)=>{
        if(error){
            callback(error);
            return;
        }

        callback(null, data);
    });
}

function searchByJoinConditions(search_wrapper, callback){
    search_wrapper = addSupplementalFields(search_wrapper);
//TODO create all the necessary aliases on the attribute columns
    let values = searchByConditions(search_wrapper, (err, data)=>{
        if(err){
            callback(err);
            return;
        }

        let next_table = search_wrapper.tables[1];
        let join = search_wrapper.joins[0];

        next_table.condition =  convertJoinToCondition(search_wrapper.tables[0], search_wrapper.tables[1], join, data);


        searchByConditions({tables:[next_table]}, (err, data2)=> {
            if (err) {
                callback(err);
                return;
            }
            let comparators = Object.values(join)[0];
            let left_attribute = comparators[0].split('.');
            let right_attribute = comparators[1].split('.');

            let left_attribute_name = findAttributeAlias(search_wrapper.tables, left_attribute[0], left_attribute[1]);
            let right_attribute_name = findAttributeAlias(search_wrapper.tables, right_attribute[0], right_attribute[1]);

            let joined = joins.hashInnerJoin(data, (obj)=>{return obj[left_attribute_name]}, data2, (obj)=>{return obj[right_attribute_name]});
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

            if(search_wrapper.order && search_wrapper.order.length > 0){
                results = sortData(results, search_wrapper);
            }

            callback(null, results);
        });
    });
}

function sortData(data, search_wrapper){
    let get_attributes = [];

    search_wrapper.tables.forEach((table)=>{
        table.get_attributes.forEach((attribute)=>{
            get_attributes.push(attribute.alias);
        });
    });

    let columns = [];
    let orders = [];
    search_wrapper.order.forEach((order_by)=>{
        let order_column = _.find(get_attributes, function(o) { return o === order_by.attribute; });
        if(!order_column){
            let order_split = order_by.attribute.split('.');
            let table = findTable(search_wrapper.tables, order_split[0]);
            order_column = table.table + '.' + order_split[1];
        }
        columns.push(order_column);
        orders.push(order_by.direction ? order_by.direction : 'asc');
    });

    return _.orderBy(data, columns, orders);
}

function addSupplementalFields(search_wrapper){
    search_wrapper.tables.forEach((table)=>{
        table.supplemental_fields = [];
    });

    search_wrapper.joins.forEach((join)=>{
        let comparators = Object.values(join)[0];

        let left_side = comparators[0].split('.');
        let right_side = comparators[1].split('.');

        search_wrapper.tables.forEach((table)=>{
            if((table.table === left_side[0] || table.alias === left_side[0])){
                table.supplemental_fields.push({attribute: left_side[1], alias:table.table + '.' + left_side[1]});
            } else if((table.table === right_side[0] || table.alias === right_side[0])){
                table.supplemental_fields.push({attribute: right_side[1], alias:table.table + '.' + right_side[1]});
            }
        });
    });

    return search_wrapper;
}

function convertJoinToCondition(left_table, right_table, join, data){
    let condition_attribute;
    let condition_values = [];
    let comparators = Object.values(join)[0];
    let left_attribute = comparators[0].split('.');
    let right_attribute = comparators[1].split('.');
    let data_attribute;

    if(left_attribute[0] === right_table.alias || left_attribute === right_table.table){
        condition_attribute = left_attribute[1];
        data_attribute = findAttributeAlias([left_table, right_table], right_attribute[0], right_attribute[1]);
    } else if(right_attribute[0] === right_table.alias || right_attribute[0] === right_table.table){
        condition_attribute = right_attribute[1];
        data_attribute = findAttributeAlias([left_table, right_table], left_attribute[0], left_attribute[1]);
    }

    condition_values = data.map((row)=> {
        return row[data_attribute];
    });

    let condition = {
        'in' : [condition_attribute, condition_values]
    };

    return condition;
}

function findAttributeAlias(tables, table_alias, attribute_alias){
    let table = findTable(tables, table_alias);
    let attribute = findAttributeByAlias(table, attribute_alias);

    if(!attribute) {
        attribute = findSupplementalAttributeByAlias(table, attribute_alias);
    }

    return attribute.alias;
}

function findTable(tables, table_alias) {
    return _.filter(tables, (table)=> {
        return table.name === table_alias || table.alias === table_alias;
    })[0];
}

function findSupplementalAttributeByAlias(table, attribute_alias){
    return _.filter(table.supplemental_fields, (attribute)=> {
        return attribute.attribute === attribute_alias;
    })[0];
}

function findAttributeByAlias(table, attribute_alias){
    return _.filter(table.get_attributes, (attribute)=> {
        return attribute.attribute === attribute_alias;
    })[0];
}

function findAttributeByName(table, attribute_name){
    return _.filter(table.get_attributes, (attribute)=> {
        return attribute.attribute === attribute_name;
    })[0];
}

RegExp.escape= function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

function createPatterns(condition, table_schema){
    let table_path = `${base_path}${table_schema.schema}/${table_schema.name}/`;
    let pattern = {};
    let operation = Object.keys(condition)[0];
    let comparators = Object.values(condition)[0];
    let column = comparators[0].split('.');
    let attribute_name = column.length > 1 ? column[1] : column[0];
    pattern.table_path = table_path;

    pattern.hash_path = `${table_path}__hdb_hash/${attribute_name}/`;

    switch(operation){
        case '=':
            let stripped_search_string = comparators[1] === '*' ? '*' :String(comparators[1]).replace(slash_regex, '').substring(0, 4000);
            pattern.folder_search = stripped_search_string;
            pattern.file_search = comparators[1] === '*' ? '*' : new RegExp(`^${RegExp.escape(comparators[1])}`);

            if(attribute_name === table_schema.hash_attribute || comparators[1] === '*'){
                pattern.folder_search = `${pattern.folder_search}.hdb`;
                pattern.folder_search_path = pattern.hash_path;
            } else {
                pattern.folder_search = `${pattern.folder_search}/*.hdb`;
                pattern.folder_search_path = `${table_path + attribute_name}/`;
            }

            break;
        case 'in':

            let file_searches = [];
            let folder_searches = [];
            comparators[1].forEach((value)=>{
                let stripped_value = String(value).replace(slash_regex, '').substring(0, 4000);
                pattern.folder_search_path = attribute_name === table_schema.hash_attribute ? pattern.hash_path : `${table_path + attribute_name}/`;

                folder_searches.push(stripped_value);
                file_searches.push(RegExp.escape(stripped_value));
            });
            pattern.file_search = new RegExp(file_searches.join('|'));
            pattern.folder_search = attribute_name === table_schema.hash_attribute ? `?(${folder_searches.join('|')}).hdb` : `?(${folder_searches.join('|')})/*.hdb`;
            break;
        default:
            break;
    }



    return pattern;
}

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

function verifyFileMatches(pattern, search_path, files, callback){
    if (pattern === '*') {
        callback(null, files);
        return;
    }

    let matches = [];
    async.each(files, function(file_name, caller){

        let file_path = `${search_path}${file_name}.hdb`;
        matchFile(file_path, pattern, (err, is_match)=>{
            if(err){
                //if there is an error log it out but don't halt the process
                console.error(err);
                return;
            }

            if(is_match){
                matches.push(file_name);
            }

            caller();
        });
    }, function(err){
        if(err){
            callback(err);
            return;
        }

        callback(null, matches);
    });
}

function findFiles(cwd, pattern, callback){
    globby(pattern, {cwd:cwd}).then(matches => {
        let match_set = new Set();
        matches.forEach(function(match) {
            match_set.add(path.basename(match).replace('.hdb', ''));
        });
        callback(null, match_set);
    }).catch((err)=>{
        callback(err);
    });
}

function matchFile(file_path, pattern, callback){
    fs.readFile(file_path, (err, data)=>{
        if(err) {
            callback(err);
            return;
        }

        callback(null, pattern.test(data.toString()));
    });
}