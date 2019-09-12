"use strict";

const evaluateTableGetAttributes = require('../../fsBridge/fsUtility/evaluateTableGetAttributes');
const heConsolidateSearchData = require('../heUtility/heConsolidateSearchData');
const heGetAttributeValues = require('../heUtility/heGetAttributeValues');
const search_validator = require('../../../../validation/searchValidator.js');

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
        let table_info = global.hdb_schema[search_object.schema][search_object.table];
        let final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);

        let hash_values = search_object.hash_values.map(hash => `${hash}`)
        let data_stores = final_get_attrs.map(attr => `${table_info.schema}/${table_info.name}/${attr}`);

        const attributes_data = heGetAttributeValues(hash_values, data_stores);
        const final_results = heConsolidateSearchData(final_get_attrs, attributes_data);

        return final_results;
    } catch(err) {
        throw err;
    }
}