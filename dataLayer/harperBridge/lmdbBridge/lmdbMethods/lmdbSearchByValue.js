'use strict';

// eslint-disable-next-line no-unused-vars
const SearchObject = require('../../../SearchObject.ts').default || require('../../../SearchObject.ts');
const searchValidator =
	require('../../../../validation/searchValidator.ts').default || require('../../../../validation/searchValidator.ts');
const commonUtils = require('../../../../utility/common_utils.ts');
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
