'use strict';

const SearchObject = require('../../../SearchObject.js');
const searchValidator = require('../../../../validation/searchValidator.js');
const commonUtils = require('../../../../utility/common_utils.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const lmdb_search = require('../lmdbUtility/lmdbSearch.js');

module.exports = lmdbSearchByValue;

/**
 * gets records by value - returns array of Objects
 * @param {SearchObject} searchObject
 * @param {hdbTerms.VALUE_SEARCH_COMPARATORS} [comparator]
 * @returns {Promise<{}|{}[]>}
 */
async function lmdbSearchByValue(searchObject, comparator) {
	let comparatorSearch = !commonUtils.isEmpty(comparator);
	if (comparatorSearch && hdbTerms.VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
		throw new Error(`Value search comparator - ${comparator} - is not valid`);
	}

	let validationError = searchValidator(searchObject, 'value');
	if (validationError) {
		throw validationError;
	}

	return lmdb_search.prepSearch(searchObject, comparator, false);
}
