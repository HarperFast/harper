'use strict';

const search_utility = require('../../../../utility/lmdb/searchUtility');
const SearchObject = require('../../../SearchObject');
const path = require('path');
const hdb_terms = require('../../../../utility/hdbTerms');
const env_mgr = require('../../../../utility/environment/environmentManager');
const system_schema = require('../../../../json/systemSchema.json');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);

module.exports = lmdbGetDataByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   search_attribute: String // attribute to search for value on
//   search_value:String, // string value to search for
//   get_attributes:Array // attributes to return with search result
// }

/**
 * gets records by value
 * @param {SearchObject} search_object
 */
function lmdbGetDataByValue(search_object, comparator) {
    //TODO implement comparator search
    let search_function = undefined;

    let table_info = null;
    if (search_object.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
        table_info = system_schema[search_object.table];
    } else {
        table_info = global.hdb_schema[search_object.schema][search_object.table];
    }

    if(search_object.search_value === '*'){
        search_function = search_utility.iterateDBI;
    }
}