"use strict";

const util = require('util');

const consolidateSearchData = require('../fsUtility/consolidateSearchData');
const evaluateTableGetAttributes = require('../fsUtility/evaluateTableGetAttributes');
const getAttributeFileValues = require('../fsUtility/getAttributeFileValues');
const getBasePath = require('../fsUtility/getBasePath');

const hdb_terms = require('../../../../utility/hdbTerms');
const condition_patterns = require('../../../../sqlTranslator/conditionPatterns');
const search_validator = require('../../../../validation/searchValidator.js');
const system_schema = require('../../../../json/systemSchema.json');

const file_search = require('../../../../lib/fileSystem/fileSearch');
const p_find_ids_by_regex = util.promisify(file_search.findIDsByRegex);

module.exports = fsGetDataByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   search_attribute: String // attribute to search for value on
//   search_value:String, // string value to search for
//   get_attributes:Array // attributes to return with search result
// }


async function fsGetDataByValue(search_object) {
    try {
        let validation_error = search_validator(search_object, 'value');
        if (validation_error) {
            throw validation_error;
        }
        let operation = '=';
        if (search_object.search_value !== '*' && search_object.search_value !== '%' && (search_object.search_value.includes('*') || search_object.search_value.includes('%'))) {
            operation = 'like';
        }
        let condition = {};
        condition[operation] = [search_object.search_attribute, search_object.search_value];

        let table_info = null;
        if (search_object.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
            // TODO: why are we getting global this way here? Related to install/run?
            table_info = system_schema[search_object.table];
        } else {
            table_info = global.hdb_schema[search_object.schema][search_object.table];
        }

        let patterns = condition_patterns.createPatterns(condition, {
            name: search_object.table,
            schema: search_object.schema,
            hash_attribute: table_info.hash_attribute
        }, getBasePath());

        const final_get_attrs = evaluateTableGetAttributes(search_object.get_attributes, table_info.attributes);
        const final_hash_results = await p_find_ids_by_regex(patterns.folder_search_path, patterns.folder_search, patterns.blob_search);

        const final_attributes_data = await getAttributeFileValues(final_get_attrs, search_object, final_hash_results);
        const final_results = consolidateSearchData(table_info.hash_attribute, final_attributes_data);

        return final_results;

    } catch(err){
        throw err;
    }
}