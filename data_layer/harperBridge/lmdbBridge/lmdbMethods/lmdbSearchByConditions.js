'use strict';

const SearchObject = require('../../../SearchObject');
const search_validator = require('../../../../validation/searchValidator');
const common_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_search = require('../lmdbUtility/lmdbSearch');

module.exports = lmdbSearchByValue;

/**
 * gets records by conditions - returns array of Objects
 * @param {SearchObject} search_object
 * @returns {Array.<Object>}
 */
async function lmdbSearchByValue(search_object) {
    let validation_error = search_validator(search_object, 'conditions');
    if (validation_error) {
        throw validation_error;
    }

    const table_info = global.hdb_schema[search_object.schema][search_object.table];

    let proto_search = new SearchObject(search_object.schema, search_object.table, undefined, undefined, table_info.hash_attribute, [table_info.hash_attribute], undefined, search_object.desc, search_object.limit, search_object.offset);

    let promises = [];
    for(let x = 0, length = search_object.conditions.length; x < length; x++){
        let search = Object.assign(new SearchObject(), proto_search);
        let condition = search_object.conditions[x];
        let search_type = condition.search_type;
        if(search_type === lmdb_terms.SEARCH_TYPES.BETWEEN){
            search.search_value = search_object.search_value[0];
            search.end_value = search_object.search_value[1];
        } else{
            search.search_value = search_object.search_value;
        }
        let promise = lmdb_search.executeSearch(search, search_type, table_info.hash_attribute, false);
        promises.push(promise);
    }

    let results = await Promise.all(promises);

}

let obj = {};
lmdbSearchByValue(obj);