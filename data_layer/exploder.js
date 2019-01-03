"use strict";

const h_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const INSERT_ENUM =  hdb_terms.INSERT_MODULE_ENUM;
const FileObject = require('../utility/fs/FileObject');
const ExplodedObject = require('./ExplodedObject');


/**
 * This function takes every row, explodes it by attribute and sends the data on to be written to disk
 * @param {./ExploderObject} exploder_object
 * @returns {./ExplodedObject}
 */
module.exports = async (exploder_object) => {
    let epoch = Date.now();

    let folders = new Set();
    let base_path = exploder_object.hdb_path + '/' + exploder_object.schema + '/' + exploder_object.table + '/';
    let skipped = [];
    let raw_data = [];

    //based on the attributes in the data set we add the paths for the attributes under __hdb_hash, do it here rather spamming the folders Set inside the loop
    exploder_object.attributes.forEach((attribute)=>{
        folders.add(`${base_path}__hdb_hash/${attribute}`);
    });

    exploder_object.records.forEach((record) => {
        if (record[INSERT_ENUM.HDB_PATH_KEY] === undefined && exploder_object.operation !== 'update') {
            skipped.push(record[exploder_object.hash_attribute]);
            return;
        }

        for (let property in record) {
            if (record[property] === null || record[property] === undefined || record[property] === '' || property === INSERT_ENUM.HDB_PATH_KEY
                || property === INSERT_ENUM.HDB_AUTH_HEADER || property === INSERT_ENUM.HDB_USER_DATA_KEY) {
                continue;
            }

            let {value, value_path} = h_utils.valueConverter(record[property]);
            let attribute_file_name = record[exploder_object.hash_attribute] + '.hdb';
            let attribute_path = base_path + property + '/' + value_path;

            let file_obj = new FileObject(`${base_path}__hdb_hash/${property}/${attribute_file_name}`, value);
            raw_data.push(file_obj);
            folders.add(attribute_path);
            if (property === exploder_object.hash_attribute) {
                raw_data.push(
                    new FileObject(`${attribute_path}/${epoch}.hdb`,JSON.stringify(record, filterHDBValues))
                );
            } else {
                file_obj.link_path = `${attribute_path}/${attribute_file_name}`;
            }
        }
    });

    let data_wrapper = new ExplodedObject(exploder_object.operation, Array.from(folders), raw_data, skipped);
    exploder_object = null;
    return  data_wrapper;
};

/**
 * This function is used to remove HDB internal values (such as HDB_INTERNAL_PATH) from the record when it
 * is stringified.
 * @param key - the key of the record
 * @param value - the value of the record
 * @returns {*}
 */
function filterHDBValues(key, value) {
    if(key === INSERT_ENUM.HDB_PATH_KEY || key === INSERT_ENUM.HDB_AUTH_HEADER || key === INSERT_ENUM.HDB_USER_DATA_KEY) {
        return undefined;
    }
    else {
        return value;
    }
}