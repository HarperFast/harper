"use strict";

const consolidateSearchData = require('../fsUtility/consolidateSearchData');
const evaluateTableGetAttributes = require('../fsUtility/evaluateTableGetAttributes');
const getAttributeFileValues = require('../fsUtility/getAttributeFileValues');
const search_validator = require('../../../../validation/searchValidator.js');

module.exports = fsGetDataByHash;

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
        let final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);

        const attributes_data = await getAttributeFileValues(final_get_attrs, search_object);
        const final_results = consolidateSearchData(table_info.hash_attribute, attributes_data);

        return final_results;
    } catch(err) {
        throw err;
    }
}