'use strict';
const fs = require('graceful-fs');
const env = require('../utility/environment/environmentManager');

const search_validator = require('../validation/searchValidator.js');
const async = require('async');
const logger = require('../utility/logging/harper_logger');
const file_search = require('../lib/fileSystem/fileSearch');
const FileSearch = require('../lib/fileSystem/SQLSearch');
const _ = require('lodash');
const condition_patterns = require('../sqlTranslator/conditionPatterns');
const {autoCast} = require('../utility/common_utils');
const math = require('mathjs');
const system_schema = require('../json/systemSchema.json');
const SelectValidator = require('../sqlTranslator/SelectValidator');

//let base_path = env.get('HDB_ROOT') + "/schema/";
// Search is used in the installer, and the base path may be undefined when search is instantiated.  Dynamically
// get the base path from the environment manager before using it.
let base_path = function() {
    return `${env.getHdbBasePath()}/schema/`;
};

math.import([
    require('../utility/functions/math/count'),
    require('../utility/functions/math/avg')
]);

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
        
        let table_path = `${base_path()}${search_object.schema}/${search_object.table}/`;
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
    attributes.forEach(attribute => {
        if (typeof attribute !== 'string') {
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
        if (search_object.search_value !== '*' && search_object.search_value !== '%' && (search_object.search_value.includes('*') || search_object.search_value.includes('%'))) {
            operation = 'like';
        }
        let condition = {};
        condition[operation] = [search_object.search_attribute, search_object.search_value];

        let hash_attribute = null;
        if (search_object.schema === 'system') {
            hash_attribute = system_schema[search_object.table].hash_attribute;
        } else {
            hash_attribute = global.hdb_schema[search_object.schema][search_object.table].hash_attribute;
        }

        let patterns = condition_patterns.createPatterns(condition, {
            name: search_object.table,
            schema: search_object.schema,
            hash_attribute: hash_attribute
        }, base_path());

        evaluateTableAttributes(search_object.get_attributes, search_object, (err, attributes) => {
            if (err) {
                callback(err);
                return;
            }

            search_object.get_attributes = attributes;

            async.waterfall([
                file_search.findIDsByRegex.bind(null, patterns.folder_search_path, patterns.folder_search, patterns.blob_search),
                getAttributeFiles.bind(null, search_object.get_attributes, patterns.table_path),
                consolidateData.bind(null, hash_attribute)
            ], (error, data) => {
                if (error) {
                    callback(error);
                    return;
                }

                return callback(null, data);
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
                getAttributeFiles.bind(null, attributes, `${base_path()}${table_schema.schema}/${table_schema.name}/`),
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

function multiConditionSearch(conditions, table_schema, callback) {
    try {
        let all_ids = [];

        async.forEachOf(conditions, (condition, key, caller) => {
            all_ids[key] = {};
            let condition_key = Object.keys(condition)[0];
            if (condition_key === 'and' || condition_key === 'or') {
                all_ids[key].operation = condition_key;
                condition = condition[condition_key];
            }

            let pattern = condition_patterns.createPatterns(condition, table_schema, base_path());

            file_search.findIDsByRegex(pattern.folder_search_path, pattern.folder_search, pattern.blob_search, (err, results) => {
                if (err) {
                    logger.error(err);
                } else {
                    all_ids[key].ids = results;
                }
                caller();
            });
        }, err => {
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

function search(statement, callback) {
    try {
        let validator = new SelectValidator(statement);
        validator.validate();

        let search = new FileSearch(validator.statement, validator.attributes);

        search.search().then(data => {
            callback(null, data);
        }).catch(e => {
           callback(e, null);
        });
    } catch(e){
        callback(e);
    }
}

RegExp.escape= function(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

function consolidateData(hash_attribute, attributes_data, callback) {
    let data_array = [];
    let data_keys = Object.keys(attributes_data);

    if (!attributes_data || data_keys.length === 0) {
        return callback(null, data_array);
    }

    let ids;
    if (attributes_data[hash_attribute]) {
        ids = Object.keys(attributes_data[hash_attribute]);
    } else {
        Object.keys(attributes_data).forEach(key => {
            let split_key = key.split('.');
            if (split_key.length > 1 && split_key[1] === hash_attribute) {
                ids = Object.keys(attributes_data[key]);
            }
        });
    }

    if (!ids) {
        ids = Object.keys(attributes_data[Object.keys(attributes_data)[0]]);
    }

    ids.forEach(function(key) {
        let data_object = {};

        data_keys.forEach(function(attribute) {
            data_object[attribute] = attributes_data[attribute][key];
        });
        data_array.push(data_object);
    });
    callback(null, data_array);
}

function getAttributeFiles(get_attributes, table_path, hash_files, callback){
    let attributes_data = {};
    async.each(get_attributes, (attribute, caller) => {
        //evaluate if an array of strings or objects has been passed in and assign values accordingly
        let attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
        let alias_name = (typeof attribute === 'string') ? attribute :
            (attribute.alias ? attribute.alias : attribute.name);
        readAttributeFiles(table_path, attribute_name, hash_files, (err, results) => {
            if (err){
                caller(err);
                return;
            }

            attributes_data[alias_name] = results;
            caller();
        });
    }, error => {
        if (error) {
            callback(error);
            return;
        }
        callback(null, attributes_data);
    });
}

function readAttributeFiles(table_path, attribute, hash_files, callback) {
    let attribute_data = {};
    async.eachLimit(hash_files, 1000, (file, caller) => {
        fs.readFile(`${table_path}__hdb_hash/${attribute}/${file}.hdb`, 'utf-8', (error, data) => {
            if(error) {
                if(error.code === 'ENOENT') {
                    caller(null, null);
                } else {
                    caller(error);
                }
                return;
            }

            let value = autoCast(data.toString());

            attribute_data[file] = value;
            caller();
        });
    }, err => {
        if (err) {
            callback(err);
            return;
        }

        callback(null, attribute_data);
    });
}

function evaluateTableAttributes(get_attributes, table_info, callback) {
    let star_attribute =  _.filter(get_attributes, attribute => attribute === '*' || attribute.attribute === '*');

    if (star_attribute && star_attribute.length > 0) {
        getAllAttributeNames(table_info, (err, attributes) => {
            if (err){
                callback(err);
                return;
            }
            get_attributes = _.filter(get_attributes, attribute => attribute !== '*' && attribute.attribute !== '*');

            attributes.forEach(attribute => {
                get_attributes.push(attribute);
            });

            callback(null, _.uniqBy(get_attributes, 'alias'));
        });
    } else {
        callback(null, get_attributes);
    }
}

function getAllAttributeNames(table_info, callback){
    let search_path = `${base_path()}${table_info.schema}/${table_info.table}/__hdb_hash/`;

    file_search.findDirectoriesByRegex(search_path, /.*/, (err, folders) => {
        if (err) {
            callback(err);
            return;
        }

        let attributes = [];
        folders.forEach(folder => {
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