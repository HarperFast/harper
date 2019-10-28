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

        const { is_range_search, search_operation, search_value } = generateSearchPattern(search_object.search_value);

        let table_info = null;
        if (search_object.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
            table_info = system_schema[search_object.table];
        } else {
            table_info = global.hdb_schema[search_object.schema][search_object.table];
        }

        const value_store = heGenerateDataStoreName(table_info.schema, table_info.name, search_object.search_attribute);

        const final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);

        // We need the make sure that the hash attr is retrieved from He in the 0 index position for each row result - to do that,
        // we check if it has been requested in the get_attrs and, if not, add it or, if so, make sure it's in the 0 index position.
        const hash_attr = table_info.hash_attribute;
        const hash_attr_index = final_get_attrs.findIndex(attr => attr === hash_attr);
        let return_hash_attr = false;

        final_get_attrs.unshift(hash_attr);
        if (hash_attr_index != -1) {
            return_hash_attr = true;
            const index_pos = hash_attr_index + 1;
            final_get_attrs.splice(index_pos, 1);
        }

        // Create data stores with hash attr in the 0 index position
        const data_stores = final_get_attrs.map(attr => heGenerateDataStoreName(table_info.schema, table_info.name, attr));

        let final_attributes_data;
        if (is_range_search) {
            final_attributes_data = hdb_helium.searchByValueRange(value_store, search_operation, search_value, null, data_stores);
        } else {
            final_attributes_data = hdb_helium.searchByValues(value_store, search_operation, [search_value], data_stores);
        }

        const final_results = consolidateValueSearchData(final_get_attrs, final_attributes_data, return_hash_attr);

        return final_results;

    } catch(err){
        throw err;
    }
}

function consolidateValueSearchData(attrs_keys, attrs_data, return_hash_attr) {
    // Check to see if the hash attr was requested and, if not, remove it from the attr_keys we use to consolidate the
    // final data below - the actual hash value in attrs_data will be handled within the loop
    if (!return_hash_attr) {
        attrs_keys.shift();
    }

    let final_data = {};

    for (const row of attrs_data) {
        //As noted above, if the hash attr was requested we just grab the value for the row object key - if it was not, we
        // shift it off of the array and set it as the row object key before looping through the final data to return
        let hash;
        if (return_hash_attr) {
             hash = row[1][0];
        } else {
            hash = row[1].shift();
        }

        final_data[hash] = {};

        for (let i = 0; i < row[1].length; i++) {
            const data = row[1][i];
            final_data[hash][attrs_keys[i]] = common_utils.autoCast(data);
        };
    };

    return final_data;
}

function generateSearchPattern(search_val) {
    let search_pattern = {
        search_operation: SEARCH_VALUE_OPS.EXACT,
        search_value: search_val,
        is_range_search: false
    };

    if (search_val === "*" || search_val === "%") {
        search_pattern.search_operation = SEARCH_RANGE_OPS.GREATER_OR_EQ;
        search_pattern.search_value = "";
        search_pattern.is_range_search = true;

        return search_pattern;
    } else {
        const starts_with_wildcard = String(search_val).startsWith('%') || String(search_val).startsWith('*');
        const ends_with_wildcard = String(search_val).endsWith('%') || String(search_val).endsWith('*');

        if (!starts_with_wildcard && !ends_with_wildcard) {
            return search_pattern;
        } else {
            search_pattern.search_value = generateFinalSearchString(search_val, starts_with_wildcard, ends_with_wildcard);
            if (starts_with_wildcard && ends_with_wildcard) {
                search_pattern.search_operation = SEARCH_VALUE_OPS.INCLUDES;
                return search_pattern;
            } else if (starts_with_wildcard) {
                search_pattern.search_operation = SEARCH_VALUE_OPS.ENDS_WITH;
                return search_pattern;
            } else if (ends_with_wildcard) {
                search_pattern.search_operation = SEARCH_VALUE_OPS.STARTS_WITH;
                return search_pattern;
            }
        }
    }
}

function generateFinalSearchString(search_val, starts_with_wildcard, ends_with_wildcard) {
    let split_string = search_val.split('');
    if (starts_with_wildcard) {
        split_string.shift();
    }
    if (ends_with_wildcard) {
        split_string.pop();
    }
    return split_string.join('');
}