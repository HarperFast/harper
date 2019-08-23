"use strict";

const fs = require('fs-extra');
const _ = require('lodash');

const { getBasePath } = require('../fsUtility/getBasePath');
const { autoCast } = require('../../../../utility/common_utils');
const search_validator = require('../../../../validation/searchValidator.js');

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   hash_values:Array, // hash values to search for
//   get_attributes:Array // attributes to return with search result
// }

async function fsGetDataByHash(search_object) {
    try {
        const validation_error = search_validator(search_object, 'hashes');
        if (validation_error) {
            throw validation_error;
        }
        // NOTE: this is replacing the getAllAttributeNames() method that was finding attributes w/ file_search.findDirectoriesByRegex()
        let table_info = global.hdb_schema[search_object.schema][search_object.table];
        let final_get_attrs = evaluateTableAttributes(search_object.get_attributes, table_info.attributes);

        const attributes_data = await getAttributeFiles(final_get_attrs, search_object);
        const final_results = consolidateData(table_info.hash_attribute, attributes_data);

        return final_results;
    } catch(err) {
        throw err;
    }
}

//TODO: we're iterating through the get_attributes parameter 2 times below, once to detect if there is a star attribute,
// and the second time when a star exists we iterate to remove it.
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

async function getAttributeFiles(get_attributes, search_object) {
    try {
        const { hash_values, schema, table } = search_object;
        let table_path = `${getBasePath()}/${schema}/${table}`;
        let attributes_data = {};

        for (const attribute of get_attributes) {
            //evaluate if an array of strings or objects has been passed in and assign values accordingly
            let attribute_name = (typeof attribute === 'string') ? attribute : attribute.attribute;
            attributes_data[attribute_name] = await readAttributeFiles(table_path, attribute_name, hash_values);
        }

        return attributes_data;
    } catch(err) {
        throw err;
    }
}

async function readAttributeFilePromise(table_path, attribute, file, attribute_data) {
    try {
        const data = await fs.readFile(`${table_path}/__hdb_hash/${attribute}/${file}.hdb`, 'utf-8');
        const value = autoCast(data.toString());
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
        return attribute_data;
    } catch(err) {
        throw err;
    }
}

function consolidateData(hash_attribute, attributes_data) {
    let results_object = {};
    let data_keys = Object.keys(attributes_data);

    if (!attributes_data || data_keys.length === 0) {
        return results_object;
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

    for (let id_key of ids) {
        const row_object = {};
        for (let attribute of data_keys) {
            row_object[attribute] = attributes_data[attribute][id_key];
        }
        results_object[id_key] = row_object;
    }

    return results_object;
}

module.exports = fsGetDataByHash;