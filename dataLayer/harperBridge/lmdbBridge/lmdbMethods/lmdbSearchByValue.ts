// eslint-disable-next-line no-unused-vars
import SearchObject from '../../../SearchObject.ts';
import searchValidator from '../../../../validation/searchValidator.ts';
import * as commonUtils from '../../../../utility/common_utils.ts';
import * as hdbTerms from '../../../../utility/hdbTerms.ts';
import * as lmdb_search from '../lmdbUtility/lmdbSearch.ts';
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
