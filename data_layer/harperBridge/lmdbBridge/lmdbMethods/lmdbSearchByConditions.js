'use strict';

const SearchByConditionsObject = require('../../../SearchByConditionsObject').SearchByConditionsObject;
const SearchObject = require('../../../SearchObject');
const search_validator = require('../../../../validation/searchValidator');
const search_utility = require('../../../../utility/lmdb/searchUtility');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_search = require('../lmdbUtility/lmdbSearch');
const _ = require('lodash');
const {getBaseSchemaPath} = require('../lmdbUtility/initializePaths');
const path = require('path');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

module.exports = lmdbSearchByConditions;

/**
 * gets records by conditions - returns array of Objects
 * @param {SearchByConditionsObject} search_object
 * @returns {Array.<Object>}
 */
async function lmdbSearchByConditions(search_object) {
    try {
        let validation_error = search_validator(search_object, 'conditions');
        if (validation_error) {
            throw handleHDBError(validation_error, validation_error.message, HTTP_STATUS_CODES.BAD_REQUEST);
        }

        let schema_path = path.join(getBaseSchemaPath(), search_object.schema.toString());
        let env = await environment_utility.openEnvironment(schema_path, search_object.table);

        const table_info = global.hdb_schema[search_object.schema][search_object.table];

        //convert sort to a map for later use
        let sort_map = Object.create(null);
        if(Array.isArray(search_object.sort_attributes)) {
            for (let x = 0, length = search_object.sort_attributes.length; x < length; x++) {
                let sort = search_object.sort_attributes[x];
                sort_map[sort.attribute] = sort.desc === true ? 'desc' : 'asc';
            }
        }

        let results = await executeConditionSearches(env, search_object, table_info.hash_attribute, sort_map);

        //get the intersection/union of ids from all condition searches
        let merged_ids = [];
        let ids = [];
        for(let x = 0, length = results.length; x < length; x++){
            ids.push(results[x][0]);
        }
        if(!search_object.operator || search_object.operator.toLowerCase() === 'and'){
            merged_ids = _.intersection(...ids);
        } else{
            merged_ids = _.union(...ids);
        }

        //perform records search by id
        let records = search_utility.batchSearchByHash(env, table_info.hash_attribute, search_object.get_attributes, merged_ids);

        //sort the records
        if(Array.isArray(search_object.sort_attributes)){
            records = _.orderBy(records, Object.keys(sort_map), Object.values(sort_map));
        }

        return records;
    } catch(e){
        throw handleHDBError(e);
    }
}

/**
 *
 * @param env
 * @param {SearchByConditionsObject} search_object
 * @param {String} hash_attribute
 * @param {{}}sort_map
 * @returns {Promise<unknown[]>}
 */
async function executeConditionSearches(env, search_object, hash_attribute, sort_map){
    //build a prototype object for search
    let proto_search = new SearchObject(search_object.schema, search_object.table, undefined, undefined,
        hash_attribute, search_object.get_attributes, undefined, undefined, search_object.limit, search_object.offset);

    //execute conditional searches
    let promises = [];
    for (let x = 0, length = search_object.conditions.length; x < length; x++) {
        let search = Object.assign(new SearchObject(), proto_search);

        let condition = search_object.conditions[x];
        let search_type = condition.search_type;
        search.search_attribute = condition.search_attribute;

        search.reverse = sort_map[search.search_attribute] === 'desc';

        if (search_type === lmdb_terms.SEARCH_TYPES.BETWEEN) {
            search.search_value = condition.search_value[0];
            search.end_value = condition.search_value[1];
        } else {
            search.search_value = condition.search_value;
        }
        let promise = lmdb_search.searchByType(env, search, search_type, hash_attribute);
        promises.push(promise);
    }
//get all promise results, this intentionally has no await as node always wraps a return in await

    return Promise.all(promises);
}
