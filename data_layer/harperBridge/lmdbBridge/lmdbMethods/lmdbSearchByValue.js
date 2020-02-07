'use strict';

const SearchObject = require('../../../SearchObject');
const search_validator = require('../../../../validation/searchValidator');
const common_utils = require('../../../../utility/common_utils');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const execute_search = require('../lmdbUtility/lmdbSearch');

module.exports = lmdbSearchByValue;

/**
 * gets records by value - returns array of Objects
 * @param {SearchObject} search_object
 * @param {lmdb_terms.SEARCH_COMPARATORS} [comparator]
 * @returns {Array.<Object>}
 */
async function lmdbSearchByValue(search_object, comparator) {
    let comparator_search = !common_utils.isEmpty(comparator);
    if (comparator_search && lmdb_terms.SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
        throw new Error(`Value search comparator - ${comparator} - is not valid`);
    }

    let validation_error = search_validator(search_object, 'value');
    if (validation_error) {
        throw validation_error;
    }

    let return_map = false;
    return await execute_search(search_object, comparator, return_map);
}