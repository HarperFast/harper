'use strict';

const SearchObject = require('../../../SearchObject');
const search_validator = require('../../../../validation/searchValidator');
const common_utils = require('../../../../utility/common_utils');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const execute_search = require('../lmdbUtility/lmdbSearch');

module.exports = lmdbGetDataByValue;

/**
 * gets records by value returns a map of objects
 * @param {SearchObject} search_object
 * @param {lmdb_terms.SEARCH_COMPARATORS} [comparator]
 * @returns {{String|Number, Object}}
 */
async function lmdbGetDataByValue(search_object, comparator) {
    let comparator_search = !common_utils.isEmpty(comparator);
    if (comparator_search && lmdb_terms.SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
        throw new Error(`Value search comparator - ${comparator} - is not valid`);
    }

    let validation_error = search_validator(search_object, 'value');
    if (validation_error) {
        throw validation_error;
    }

    let return_map = true;
    return await execute_search(search_object, comparator, return_map);
}

