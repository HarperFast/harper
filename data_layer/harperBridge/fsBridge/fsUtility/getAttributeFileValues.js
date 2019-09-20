"use strict";

const _ = require('lodash');
const fs = require('fs-extra');

const common_utils = require('../../../../utility/common_utils');
const getBasePath = require('./getBasePath');
const hdb_terms = require('../../../../utility/hdbTerms');

module.exports = getAttributeFileValues;

async function getAttributeFileValues(get_attributes, search_object, hash_results, hash_attr) {
    try {
        const { schema, table } = search_object;
        const hash_values = hash_results ? hash_results : search_object.hash_values;
        let table_path = `${getBasePath()}/${schema}/${table}`;
        let attributes_data = {};

        for (const attribute of get_attributes) {
            //evaluate if an array of strings or objects has been passed in and assign values accordingly
            let attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
            //if attribute is the hash value, assign hash_result values to hash
            if (attribute_name === hash_attr) {
                let hash_attr_data = {};
                for (const file of hash_values) {
                    hash_attr_data[file] = file;
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

async function readAttributeFilePromise(table_path, attribute, file, attribute_data) {
    try {
        const data = await fs.readFile(`${table_path}/${hdb_terms.HASH_FOLDER_NAME}/${attribute}/${file}${hdb_terms.HDB_FILE_SUFFIX}`, 'utf-8');
        const value = common_utils.autoCast(data.toString());
        attribute_data[file] = value;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw(err);
        }
    }
}

async function readAttributeFiles(table_path, attribute, hash_files) {
    try {
        let attribute_data = {};
        const readFileOps = [];

        for (const file of hash_files) {
            readFileOps.push(readAttributeFilePromise(table_path, attribute, file, attribute_data));
        }

        await Promise.all(readFileOps);
        // if (!_.isEmpty(attribute_data)) {
            return attribute_data;
        // }
    } catch(err) {
        throw err;
    }
}