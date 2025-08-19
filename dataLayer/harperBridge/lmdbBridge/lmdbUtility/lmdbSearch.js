'use strict';

const searchUtility = require('../../../../utility/lmdb/searchUtility.js');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const commonUtils = require('../../../../utility/common_utils.js');
const lmdbTerms = require('../../../../utility/lmdb/terms.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const systemSchema = require('../../../../json/systemSchema.json');
const LMDB_ERRORS = require('../../../../utility/errors/commonErrors.js').LMDB_ERRORS_ENUM;
const { getSchemaPath } = require('./initializePaths.js');

const WILDCARDS = hdbTerms.SEARCH_WILDCARDS;

/**
 * gets the searchType & based on the size of the dbi being searched will either perform an in process search or launch a new process to perform a search
 * @param {SearchObject} searchObject
 * @param {hdbTerms.VALUE_SEARCH_COMPARATORS} comparator
 * @param {Boolean} returnMap
 * @returns {{}|[{}]}
 */
async function prepSearch(searchObject, comparator, returnMap) {
	let tableInfo;
	if (searchObject.schema === hdbTerms.SYSTEM_SCHEMA_NAME) {
		tableInfo = systemSchema[searchObject.table];
	} else {
		tableInfo = global.hdb_schema[searchObject.schema][searchObject.table];
	}

	let searchType = createSearchTypeFromSearchObject(searchObject, tableInfo.hash_attribute, returnMap, comparator);

	return executeSearch(searchObject, searchType, tableInfo.hash_attribute, returnMap);
}

/**
 * executes a specific search based on the evaluation of the searchObject & optional comparator & returns the results
 * @param {SearchObject} searchObject
 * @param {lmdbTerms.SEARCH_TYPES} searchType
 * @param {String} hash_attribute
 * @param {Boolean} returnMap
 */
async function executeSearch(searchObject, searchType, hash_attribute, returnMap) {
	let schemaPath = getSchemaPath(searchObject.schema, searchObject.table);
	let env = await environmentUtility.openEnvironment(schemaPath, searchObject.table);
	let searchResults = searchByType(env, searchObject, searchType, hash_attribute);
	let transaction = searchResults.transaction || env;

	//if we execute a search all / search by hash type call there is no need to perform further evaluation as the records have been fetched
	if (
		[
			lmdbTerms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH,
			lmdbTerms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP,
			lmdbTerms.SEARCH_TYPES.SEARCH_ALL,
			lmdbTerms.SEARCH_TYPES.SEARCH_ALL_TO_MAP,
		].indexOf(searchType) >= 0
	) {
		return searchResults;
	}

	let fetchMore = checkToFetchMore(searchObject, hash_attribute);

	if (fetchMore === false) {
		let attribute = searchObject.attribute;
		if (attribute === hash_attribute) {
			if (returnMap) return createMapFromIterable(searchResults, () => true);
			return searchResults.map((entry) => ({ [hash_attribute]: entry.key }));
		}
		let toObject = (entry) => ({
			[hash_attribute]: entry.value,
			[attribute]: entry.key,
		});
		if (returnMap) return createMapFromIterable(searchResults, toObject);
		return searchResults.map(toObject);
	}

	let ids =
		searchObject.attribute === hash_attribute
			? searchResults.map((entry) => entry.key)
			: searchResults.map((entry) => entry.value);
	if (returnMap === true) {
		return searchUtility.batchSearchByHashToMap(transaction, hash_attribute, searchObject.get_attributes, ids);
	}

	return searchUtility.batchSearchByHash(transaction, hash_attribute, searchObject.get_attributes, ids);
}

/**
 *
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {SearchObject} searchObject
 * @param {lmdbTerms.SEARCH_TYPES} searchType
 * @param {String} hash_attribute
 * @returns {null|Array<Object>|Number|Object|*[]|{}}
 */
function searchByType(transactionOrEnv, searchObject, searchType, hash_attribute) {
	let searchResults;

	//this is to conditionally not create the hash_attribute as part of the returned objects if it is not selected
	let hashAttributeName = hash_attribute;
	if (searchObject.get_attributes.indexOf(hash_attribute) < 0) {
		hashAttributeName = undefined;
	}

	let { reverse, limit, offset } = searchObject;
	reverse = typeof reverse === 'boolean' ? reverse : false;
	limit = Number.isInteger(limit) ? limit : undefined;
	offset = Number.isInteger(offset) ? offset : undefined;

	switch (searchType) {
		case lmdbTerms.SEARCH_TYPES.EQUALS:
			searchResults = searchUtility.equals(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.CONTAINS:
			searchResults = searchUtility.contains(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.ENDS_WITH:
		case lmdbTerms.SEARCH_TYPES._ENDS_WITH:
			searchResults = searchUtility.endsWith(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.STARTS_WITH:
		case lmdbTerms.SEARCH_TYPES._STARTS_WITH:
			searchResults = searchUtility.startsWith(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH:
			return searchUtility.batchSearchByHash(transactionOrEnv, searchObject.attribute, searchObject.get_attributes, [
				searchObject.value,
			]);
		case lmdbTerms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP:
			return searchUtility.batchSearchByHashToMap(
				transactionOrEnv,
				searchObject.attribute,
				searchObject.get_attributes,
				[searchObject.value]
			);
		case lmdbTerms.SEARCH_TYPES.SEARCH_ALL:
			return searchUtility.searchAll(
				transactionOrEnv,
				hash_attribute,
				searchObject.get_attributes,
				reverse,
				limit,
				offset
			);
		case lmdbTerms.SEARCH_TYPES.SEARCH_ALL_TO_MAP:
			return searchUtility.searchAllToMap(
				transactionOrEnv,
				hash_attribute,
				searchObject.get_attributes,
				reverse,
				limit,
				offset
			);
		case lmdbTerms.SEARCH_TYPES.BETWEEN:
			searchResults = searchUtility.between(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				searchObject.end_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.GREATER_THAN:
		case lmdbTerms.SEARCH_TYPES._GREATER_THAN:
			searchResults = searchUtility.greaterThan(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdbTerms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			searchResults = searchUtility.greaterThanEqual(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.LESS_THAN:
		case lmdbTerms.SEARCH_TYPES._LESS_THAN:
			searchResults = searchUtility.lessThan(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdbTerms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdbTerms.SEARCH_TYPES._LESS_THAN_EQUAL:
			searchResults = searchUtility.lessThanEqual(
				transactionOrEnv,
				hashAttributeName,
				searchObject.attribute,
				searchObject.value,
				reverse,
				limit,
				offset
			);
			break;
		default:
			return Object.create(null);
	}

	return searchResults;
}

/**
 *
 * @param {Iterable}
 */
function createMapFromIterable(iterable, toValue) {
	let results = new Map();
	for (let entry of iterable) {
		results.set(entry.value, toValue(entry));
	}
	return results;
}

/**
 *
 * @param {SearchObject} searchObject
 * @param {String} hash_attribute
 */
function checkToFetchMore(searchObject, hash_attribute) {
	if (searchObject.get_attributes.length === 1 && searchObject.get_attributes[0] === '*') {
		return true;
	}
	let alreadyFetchedAttributes = [searchObject.attribute];
	if (searchObject.get_attributes.indexOf(hash_attribute) >= 0) {
		alreadyFetchedAttributes.push(hash_attribute);
	}

	let fetchMore = false;
	for (let x = 0; x < searchObject.get_attributes.length; x++) {
		if (alreadyFetchedAttributes.indexOf(searchObject.get_attributes[x]) < 0) {
			fetchMore = true;
			break;
		}
	}

	return fetchMore;
}

/**
 * evaluates the searchObject to determine what the searchType needs to be for later execution of queries
 * @param {SearchObject} searchObject
 * @param {String} hash_attribute
 * @param {hdbTerms.VALUE_SEARCH_COMPARATORS} comparator
 * @param {Boolean} returnMap
 * @returns {lmdbTerms.SEARCH_TYPES}
 */
function createSearchTypeFromSearchObject(searchObject, hash_attribute, returnMap, comparator) {
	if (commonUtils.isEmpty(comparator)) {
		let searchValue = searchObject.value;
		if (typeof searchValue === 'object') {
			searchValue = JSON.stringify(searchValue);
		} else {
			searchValue = searchValue.toString();
		}

		let firstSearchCharacter = searchValue.charAt(0);
		let lastSearchCharacter = searchValue.charAt(searchValue.length - 1);
		let hashSearch = false;
		if (searchObject.attribute === hash_attribute) {
			hashSearch = true;
		}

		if (WILDCARDS.indexOf(searchValue) > -1) {
			return returnMap === true ? lmdbTerms.SEARCH_TYPES.SEARCH_ALL_TO_MAP : lmdbTerms.SEARCH_TYPES.SEARCH_ALL;
		}

		if (searchValue.indexOf(WILDCARDS[0]) < 0 && searchValue.indexOf(WILDCARDS[1]) < 0) {
			if (hashSearch === true) {
				return returnMap === true
					? lmdbTerms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP
					: lmdbTerms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH;
			}

			return lmdbTerms.SEARCH_TYPES.EQUALS;
		}

		if (WILDCARDS.indexOf(firstSearchCharacter) >= 0 && WILDCARDS.indexOf(lastSearchCharacter) >= 0) {
			//this removes the first  & last character from the search value
			searchObject.value = searchObject.value.slice(1, -1);
			return lmdbTerms.SEARCH_TYPES.CONTAINS;
		}

		if (WILDCARDS.indexOf(firstSearchCharacter) >= 0) {
			searchObject.value = searchObject.value.substr(1);
			return lmdbTerms.SEARCH_TYPES.ENDS_WITH;
		}

		if (WILDCARDS.indexOf(lastSearchCharacter) >= 0) {
			searchObject.value = searchObject.value.slice(0, -1);
			return lmdbTerms.SEARCH_TYPES.STARTS_WITH;
		}

		if (searchValue.includes(WILDCARDS[0]) || searchValue.includes(WILDCARDS[1])) {
			return lmdbTerms.SEARCH_TYPES.EQUALS;
		}

		throw new Error(LMDB_ERRORS.UNKNOWN_SEARCH_TYPE);
	} else {
		switch (comparator) {
			case hdbTerms.VALUE_SEARCH_COMPARATORS.BETWEEN:
				return lmdbTerms.SEARCH_TYPES.BETWEEN;
			case hdbTerms.VALUE_SEARCH_COMPARATORS.GREATER:
				return lmdbTerms.SEARCH_TYPES.GREATER_THAN;
			case hdbTerms.VALUE_SEARCH_COMPARATORS.GREATER_OR_EQ:
				return lmdbTerms.SEARCH_TYPES.GREATER_THAN_EQUAL;
			case hdbTerms.VALUE_SEARCH_COMPARATORS.LESS:
				return lmdbTerms.SEARCH_TYPES.LESS_THAN;
			case hdbTerms.VALUE_SEARCH_COMPARATORS.LESS_OR_EQ:
				return lmdbTerms.SEARCH_TYPES.LESS_THAN_EQUAL;
			default:
				throw new Error(LMDB_ERRORS.UNKNOWN_SEARCH_TYPE);
		}
	}
}

module.exports = {
	executeSearch,
	createSearchTypeFromSearchObject,
	prepSearch,
	searchByType,
	//	filterByType,
};
