"use strict";

const common_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const search_validator = require('../../../../validation/searchValidator.js');
const SEARCH_VALUE_OPS = hdb_terms.HELIUM_VALUE_SEARCH_OPS;
const SEARCH_RANGE_OPS = hdb_terms.HELIUM_VALUE_RANGE_SEARCH_OPS;
const system_schema = require('../../../../json/systemSchema.json');

const evaluateTableGetAttributes = require('../../bridgeUtility/evaluateTableGetAttributes');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');

const helium_utils = require('../../../../utility/helium/heliumUtils');
let hdb_helium;
try {
    hdb_helium = helium_utils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heGetDataByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   search_attribute: String // attribute to search for value on
//   search_value:String, // string value to search for
//   get_attributes:Array // attributes to return with search result
// }


function heGetDataByValue(search_object) {
    try {
        let validation_error = search_validator(search_object, 'value');
        if (validation_error) {
            throw validation_error;
        }

        let operation = SEARCH_VALUE_OPS.EXACT;
        let is_range_search = false;
        let search_value = search_object.search_value;

        if (search_object.search_value === '*') {
            operation = SEARCH_RANGE_OPS.GREATER_OR_EQ;
            is_range_search = true;
            search_value = "";
        }

        // TODO: Add functionality for determining search value search operations logic
        // if (search_object.search_value !== '*' && search_object.search_value !== '%' && (search_object.search_value.includes('*') || search_object.search_value.includes('%'))) {
        //     operation = 'like';
        // }
        // const condition = {};
        // condition[operation] = [search_object.search_attribute, search_object.search_value];

        let table_info = null;
        if (search_object.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
            table_info = system_schema[search_object.table];
        } else {
            table_info = global.hdb_schema[search_object.schema][search_object.table];
        }

        const value_store = heGenerateDataStoreName(table_info.schema, table_info.name, search_object.search_attribute);

        const final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);
        //TODO: figure out better way to ensure we get the hash value included in results when not included in get_attrs
        final_get_attrs.unshift(table_info.hash_attribute);

        const data_stores = final_get_attrs.map(attr => heGenerateDataStoreName(table_info.schema, table_info.name, attr));

        let final_attributes_data;

        if (is_range_search) {
            final_attributes_data = hdb_helium.searchByValueRange(value_store, operation, search_value, null, data_stores);
        } else {
            final_attributes_data = hdb_helium.searchByValues(value_store, operation, [search_value], data_stores);
        }

        const final_results = consolidateValueSearchData(final_get_attrs, final_attributes_data);

        return final_results;

    } catch(err){
        throw err;
    }
}

function consolidateValueSearchData(attrs_keys, data) {
    let final_data = {};
    //we add the hash datastore to the search to ensure we have the hash value for each row
    //- we remove the attr_key here and the actual value below after we grab it for the final data obj
    attrs_keys.shift();

    for (const row of data) {
        //as noted above, we remove the hash value after grabbing it for the final_data row obj key
        const hash = row[1].shift();
        final_data[hash] = {};

        for (let i = 0; i < row[1].length; i++) {
            const data = row[1][i];
            final_data[hash][attrs_keys[i]] = common_utils.autoCast(data);
        };
    };

    return final_data;
}