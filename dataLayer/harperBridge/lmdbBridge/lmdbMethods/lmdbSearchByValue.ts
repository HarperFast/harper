'use strict';;
import * as SearchObject from '../../../SearchObject.js';
import * as searchValidator from '../../../../validation/searchValidator.js';
import * as commonUtils from '../../../../utility/common_utils.js';
import * as hdbTerms from '../../../../utility/hdbTerms.js';
import * as lmdb_search from '../lmdbUtility/lmdbSearch.js';
export default lmdbSearchByValue;

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
