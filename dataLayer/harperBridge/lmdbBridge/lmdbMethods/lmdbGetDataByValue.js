'use strict';

const SearchObject = require('../../../SearchObject.js');
const searchValidator = require('../../../../validation/searchValidator.js');
const commonUtils = require('../../../../utility/common_utils.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const lmdbSearch = require('../lmdbUtility/lmdbSearch.js');

module.exports = lmdbGetDataByValue;

/**
 * gets records by value returns a map of objects
 * @param {SearchObject} searchObject
 * @param {hdbTerms.VALUE_SEARCH_COMPARATORS} [comparator]
 * @returns {{String|Number, Object}}
 */
function lmdbGetDataByValue(searchObject, comparator) {
	let comparatorSearch = !commonUtils.isEmpty(comparator);
	if (comparatorSearch && hdbTerms.VALUE_SEARCH_COMPARATORS_REVERSE_LOOKUP[comparator] === undefined) {
		throw new Error(`Value search comparator - ${comparator} - is not valid`);
	}

	let validationError = searchValidator(searchObject, 'value');
	if (validationError) {
		throw validationError;
	}

	let returnMap = true;
	return lmdbSearch.prepSearch(searchObject, comparator, returnMap);
}
