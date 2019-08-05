"use strict";

const fs = require('graceful-fs');
const _ = require('lodash');
const async = require('async');

const { getBasePath } = require('../fsUtilities');
const { autoCast } = require('../../../../utility/common_utils');

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   hash_values:Array, // hash values to search for
//   get_attributes:Array // attributes to return with search result
// }

function fsGetDataByHash(search_object, callback) {
    let table_info = global.hdb_schema[search_object.schema][search_object.table];
    let final_get_attrs = evaluateTableAttributes(search_object.get_attributes, table_info.attributes);

    async.waterfall([
        getAttributeFiles.bind(null, final_get_attrs, search_object),
        consolidateData.bind(null, table_info.hash_attribute)
    ], (error, data) => {
        if (error) {
            callback(error);
            return;
        }
        callback(null, data);
    });
}

//TODO: we're iterating through the get_attributes parameter 2 times below, once to detect if there is a star attribute, and the second time when a star exists we iterate to remove it.
// This is (O)n^2, and not needed - update during next performance pass.
function evaluateTableAttributes(get_attributes, table_attributes) {
    let star_attribute =  _.filter(get_attributes, attribute => {
        return attribute === '*' || attribute.attribute === '*';
    });

    if (star_attribute && star_attribute.length > 0) {
        get_attributes = _.filter(get_attributes, attribute => {
            return attribute !== '*' && attribute.attribute !== '*';
        });

        table_attributes.forEach(attribute => {
            get_attributes.push(attribute.attribute);
        });

        return _.uniqBy(get_attributes);
    }

    return get_attributes;
}

// function getAllAttributeNames(table_info, callback){
//     let search_path = `${base_path()}${table_info.schema}/${table_info.table}/__hdb_hash/`;
//
//     file_search.findDirectoriesByRegex(search_path, /.*/, (err, folders) => {
//         if (err) {
//             callback(err);
//             return;
//         }
//
//         let attributes = [];
//         folders.forEach(folder => {
//             attributes.push({
//                 attribute:folder,
//                 alias: folder,
//                 table:table_info.table,
//                 table_alias:table_info.alias ? table_info.alias : table_info.table
//             });
//         });
//
//         callback(null, attributes);
//     });
// }

function getAttributeFiles(get_attributes, search_object, callback) {
    const { hash_values, schema, table } = search_object;
    let table_path = `${getBasePath()}${schema}/${table}`;

    let attributes_data = {};
    async.each(get_attributes, (attribute, caller) => {
        //evaluate if an array of strings or objects has been passed in and assign values accordingly
        let attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
        readAttributeFiles(table_path, attribute_name, hash_values, (err, results) => {
            if (err){
                caller(err);
                return;
            }

            attributes_data[attribute_name] = results;
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
        fs.readFile(`${table_path}/__hdb_hash/${attribute}/${file}.hdb`, 'utf-8', (error, data) => {
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

function consolidateData(hash_attribute, attributes_data, callback) {
    let results_object = {};
    let data_keys = Object.keys(attributes_data);

    if (!attributes_data || data_keys.length === 0) {
        return callback(null, results_object);
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
        const row_object = {};

        data_keys.forEach(function(attribute) {
            row_object[attribute] = attributes_data[attribute][key];
        });
        results_object[key] = row_object;
    });

    callback(null, results_object);
}

module.exports = fsGetDataByHash;