import searchValidator from '../../../../validation/searchValidator.ts';
import * as commonUtils from '../../../../utility/common_utils.ts';
import * as hdbTerms from '../../../../utility/hdbTerms.ts';
import * as lmdbSearch from '../lmdbUtility/lmdbSearch.ts';
export default lmdbGetDataByValue;

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
