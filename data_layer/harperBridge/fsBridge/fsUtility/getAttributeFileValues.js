"use strict";

const _ = require('lodash');
const fs = require('fs-extra');

const common_utils = require('../../../../utility/common_utils');
const getBasePath = require('./getBasePath');
const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = getAttributeFileValues;

async function getAttributeFileValues(get_attributes, search_object, hash_attr, hash_results) {
    try {
        let attributes_data = {};
        let hash_values = [];

        const { schema, table } = search_object;
        let table_path = `${getBasePath()}/${schema}/${table}`;

        if (hash_results) {
            hash_values = hash_results;
        } else {
            hash_values = await validateHashValuesExist(table_path, hash_attr, search_object.hash_values);
        }

        //if there are no valid hash values to find attribute values for, return an empty attr data obj
        if (common_utils.isEmptyOrZeroLength(hash_values)) {
            return attributes_data;
        }

        for (const attribute of get_attributes) {
            //evaluate if an array of strings or objects has been passed in and assign values accordingly
            const attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
            const is_hash = attribute_name === hash_attr;
            //if attribute is the hash value, assign hash_result values to hash
            if (is_hash) {
                let hash_attr_data = {};
                for (const file of hash_values) {
                    hash_attr_data[file] = common_utils.autoCast(file);
                }
                attributes_data[attribute_name] = hash_attr_data;
            } else {
                const attribute_file_values = await readAttributeFiles(table_path, attribute_name, hash_values);
                if (!_.isEmpty(attribute_file_values)) {
                    attributes_data[attribute_name] = attribute_file_values;
                }
            }
        }
        return attributes_data;
    } catch(err) {
        throw err;
    }
}

async function readAttributeFilePromise(table_path, attribute, file, attribute_data, is_hash) {
    try {
        const data = await fs.readFile(`${table_path}/${hdb_terms.HASH_FOLDER_NAME}/${attribute}/${file}${hdb_terms.HDB_FILE_SUFFIX}`, 'utf-8');
        const value = common_utils.autoCast(data.toString());
        attribute_data[file] = value;
    } catch (err) {
        if (err.code === 'ENOENT') {
            if (!is_hash) {
                attribute_data[file] = null;
            }
        } else {
            throw(err);
        }
    }
}

async function readAttributeFiles(table_path, attribute, hash_files, is_hash) {
    try {
        let attribute_data = {};
        const readFileOps = [];

        for (const file of hash_files) {
            readFileOps.push(readAttributeFilePromise(table_path, attribute, file, attribute_data, !!is_hash));
        }

        await Promise.all(readFileOps);

        return attribute_data;
    } catch(err) {
        throw err;
    }
}

async function validateHashValuesExist(table_path, hash_attr, hash_files) {
    const valid_hashes = await readAttributeFiles(table_path, hash_attr, hash_files, true);
    return Object.keys(valid_hashes);
}