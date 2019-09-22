"use strict";

const evaluateTableGetAttributes = require('../../bridgeUtility/evaluateTableGetAttributes');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const search_validator = require('../../../../validation/searchValidator.js');
const common_utils = require('../../../../utility/common_utils');

const heliumUtil = require('../../../../utility/helium/heliumUtils');
const hdb_helium = heliumUtil.initializeHelium();

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

        const final_results = consolidateSearchData(final_get_attrs, final_attributes_data);

        return final_results;
    } catch(err) {
        throw err;
    }
}

function consolidateSearchData(attrs_keys, attrs_data) {
    let final_data = {};

    attrs_data.forEach(row => {
        let row_obj = {};
        row[1].forEach((data, i) => {
            row_obj[attrs_keys[i]] = common_utils.autoCast(data.toString());
        });
        final_data[row[0]] = row_obj;
    });

    return final_data;
}