'use strict';

const search_utility = require('../../../../utility/lmdb/searchUtility');
const SearchObject = require('../../../SearchObject');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const common_utils = require('../../../../utility/common_utils');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const hdb_terms = require('../../../../utility/hdbTerms');
const env_mgr = require('../../../../utility/environment/environmentManager');
const system_schema = require('../../../../json/systemSchema.json');
const LMDB_ERRORS = require('../../../../utility/commonErrors').LMDB_ERRORS_ENUM;
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}

const BASE_SCHEMA_PATH = path.join(env_mgr.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);
const WILDCARDS = hdb_terms.SEARCH_WILDCARDS;

let WILDCARD_REPLACE_REGEX = new RegExp(/[*%]/, 'g');

/**
 * executes a specific search based on the evaluation of the search_object & optional comparator & returns the results
 * @param {SearchObject} search_object
 * @param {lmdb_terms.SEARCH_COMPARATORS} [comparator]
 * @param {Boolean} return_map
 */
async function executeSearch(search_object, comparator, return_map){
    let table_info = null;
    if (search_object.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
        table_info = system_schema[search_object.table];
    } else {
        table_info = global.hdb_schema[search_object.schema][search_object.table];
    }

    let schema_path = path.join(BASE_SCHEMA_PATH, search_object.schema);
    let env = await environment_utility.openEnvironment(schema_path, search_object.table);
    let ids = [];
    if(common_utils.isEmpty(comparator)){
        let search_type = createSearchTypeFromSearchObject(search_object, table_info.hash_attribute, return_map);
        search_object.search_value = search_object.search_value.replace(WILDCARD_REPLACE_REGEX, '');
        switch (search_type) {
            case lmdb_terms.SEARCH_TYPES.EQUALS:
                ids = search_utility.equals(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_TYPES.CONTAINS:
                ids = search_utility.contains(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
                ids = search_utility.endsWith(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
                ids = search_utility.startsWith(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH:
                return search_utility.batchSearchByHash(env, search_object.search_attribute, search_object.get_attributes, [search_object.search_value]);
            case lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP:
                return search_utility.batchSearchByHashToMap(env, search_object.search_attribute, search_object.get_attributes, [search_object.search_value]);
            case lmdb_terms.SEARCH_TYPES.SEARCH_ALL:
                return search_utility.searchAll(env, table_info.hash_attribute, search_object.get_attributes);
            case lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP:
                return search_utility.searchAllToMap(env, table_info.hash_attribute, search_object.get_attributes);
            default:
                return ids;
        }
    } else{
        switch (comparator) {
            case lmdb_terms.SEARCH_COMPARATORS.BETWEEN:
                ids = search_utility.between(env, search_object.search_attribute, search_object.search_value, search_object.end_value);
                break;
            case lmdb_terms.SEARCH_COMPARATORS.GREATER:
                ids = search_utility.greaterThan(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_COMPARATORS.GREATER_OR_EQ:
                ids = search_utility.greaterThanEqual(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_COMPARATORS.LESS:
                ids = search_utility.lessThan(env, search_object.search_attribute, search_object.search_value);
                break;
            case lmdb_terms.SEARCH_COMPARATORS.LESS_OR_EQ:
                ids = search_utility.lessThanEqual(env, search_object.search_attribute, search_object.search_value);
                break;
            default:
                return ids;
        }
    }

    if(return_map === true){
        return search_utility.batchSearchByHashToMap(env, table_info.hash_attribute, search_object.get_attributes, ids);
    }

    return search_utility.batchSearchByHash(env, table_info.hash_attribute, search_object.get_attributes, ids);
}

/**
 * evaluates the search_object to determine what the search_type needs to be for later execution of queries
 * @param {SearchObject} search_object
 * @param {String} hash_attribute
 * @param {Boolean} return_map
 * @returns {string}
 */
function createSearchTypeFromSearchObject(search_object, hash_attribute, return_map){
    let search_value = search_object.search_value;
    let first_search_character = search_value.charAt(0);
    let last_search_character = search_value.charAt(search_value.length - 1);
    let hash_search = false;
    if(search_object.search_attribute === hash_attribute){
        hash_search = true;
    }

    if(WILDCARDS.indexOf(search_value) > -1){
        return return_map === true ? lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP : lmdb_terms.SEARCH_TYPES.SEARCH_ALL;
    }

    if(search_value.indexOf(WILDCARDS[0]) < 0 && search_value.indexOf(WILDCARDS[1]) < 0){
        if(hash_search === true){
            return return_map === true ? lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP : lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH;
        }

        return lmdb_terms.SEARCH_TYPES.EQUALS;
    }

    if(WILDCARDS.indexOf(first_search_character) >= 0 && WILDCARDS.indexOf(last_search_character) >= 0){
        return lmdb_terms.SEARCH_TYPES.CONTAINS;
    }

    if(WILDCARDS.indexOf(first_search_character) >= 0){
        return lmdb_terms.SEARCH_TYPES.ENDS_WITH;
    }

    if(WILDCARDS.indexOf(last_search_character) >= 0){
        return lmdb_terms.SEARCH_TYPES.STARTS_WITH;
    }

    throw new Error(LMDB_ERRORS.UKNOWN_SEARCH_TYPE);
}

module.exports = executeSearch;