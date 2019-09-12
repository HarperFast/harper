"use strict";

const hdb_terms = require('../../../../utility/hdbTerms');
const search_validator = require('../../../../validation/searchValidator.js');
const system_schema = require('../../../../json/systemSchema.json');

const heliumUtil = require('../../../../utility/helium/heliumUtils');
const evaluateTableGetAttributes = require('../../bridgeUtility/evaluateTableGetAttributes');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');

const HE_SEARCH_OPERATIONS = {
    EXACT: 'exact',
    STARTS_WITH: 'startsWith',
    ENDS_WITH: 'endsWith',
    INCLUDES: 'includes',
    EXACT_NO_CASE: 'exactNoCase',
    STARTS_WITH_NO_CASE: 'startsWithNoCase',
    ENDS_WITH_NO_CASE: 'endsWithNoCase',
    INCLUDES_NO_CASE: 'includesNoCase'
}

// const file_search = require('../../../../lib/fileSystem/fileSearch');
// const p_find_ids_by_regex = util.promisify(file_search.findIDsByRegex);

module.exports = heGetDataByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   search_attribute: String // attribute to search for value on
//   search_value:String, // string value to search for
//   get_attributes:Array // attributes to return with search result
// }


async function heGetDataByValue(search_object) {
    try {
        let validation_error = search_validator(search_object, 'value');
        if (validation_error) {
            throw validation_error;
        }

        let operation = HE_SEARCH_OPERATIONS.EXACT;
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
        const search_values = [search_object.search_value];

        const final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);
        const data_stores = final_get_attrs.map(attr => heGenerateDataStoreName(table_info.schema, table_info.name, attr));

        const helium = heliumUtil.initializeHelium();
        const final_attributes_data = helium.searchByValues(value_store, operation, search_values, data_stores);
        heliumUtil.terminateHelium(helium);

        const final_results = consolidateSearchData(search_object.search_value, final_get_attrs, final_attributes_data);

        return final_results;

    } catch(err){
        throw err;
    }
}

function consolidateSearchData(search_attr, attrs_keys, data) {
    return {};
}