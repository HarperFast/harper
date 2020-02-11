'use strict';

const SearchObject = require('../../../SearchObject');
const search_validator = require('../../../../validation/searchValidator');
const common_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_search = require('../lmdbUtility/lmdbSearch');

module.exports = lmdbSearchByValue;

/**
 * gets records by value - returns array of Objects
 * @param {SearchObject} search_object
 * @param {hdb_terms.VALUE_SEARCH_COMPARATORS} [comparator]
 * @returns {Array.<Object>}
 */
async function lmdbSearchByValue(search_object, comparator) {
    let comparator_search = !common_utils.isEmpty(comparator);
    if (comparator_search && hdb_terms.VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
        throw new Error(`Value search comparator - ${comparator} - is not valid`);
    }

    let validation_error = search_validator(search_object, 'value');
    if (validation_error) {
        throw validation_error;
    }

    let return_map = false;
    try {
        return await lmdb_search.prepSearch(search_object, comparator, return_map);
    }catch(e){
        throw e;
    }
}

