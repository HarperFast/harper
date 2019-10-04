"use strict";

const evaluateTableGetAttributes = require('../../bridgeUtility/evaluateTableGetAttributes');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const search_validator = require('../../../../validation/searchValidator.js');
const common_utils = require('../../../../utility/common_utils');

const helium_utils = require('../../../../utility/helium/heliumUtils');
let hdb_helium;
try {
    hdb_helium = helium_utils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heGetDataByHash;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   hash_values:Array, // hash values to search for
//   get_attributes:Array // attributes to return with search result
// }

function heGetDataByHash(search_object) {
    try {
        const validation_error = search_validator(search_object, 'hashes');
        if (validation_error) {
            throw validation_error;
        }
        const table_info = global.hdb_schema[search_object.schema][search_object.table];
        const final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);

        const hash_values = search_object.hash_values.map(hash => `${hash}`);
        const data_stores = final_get_attrs.map(attr => heGenerateDataStoreName(table_info.schema, table_info.name, attr));

        const final_attributes_data = hdb_helium.searchByKeys(hash_values, data_stores);

        const final_results = consolidateHashSearchData(final_get_attrs, final_attributes_data);

        return final_results;
    } catch(err) {
        throw err;
    }
}

function consolidateHashSearchData(attrs_keys, attrs_data) {
    let final_data = {};

    for (const row of attrs_data) {
        const hash = row[0];
        final_data[hash] = {};

        for (let i = 0; i < row[1].length; i++) {
            const data = row[1][i];
            final_data[hash][attrs_keys[i]] = common_utils.autoCast(data);
        }
    }

    return final_data;
}