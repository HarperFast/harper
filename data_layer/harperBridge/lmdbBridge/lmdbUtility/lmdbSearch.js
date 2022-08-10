'use strict';

const search_utility = require('../../../../utility/lmdb/searchUtility');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const common_utils = require('../../../../utility/common_utils');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const hdb_terms = require('../../../../utility/hdbTerms');
const { getBaseSchemaPath } = require('../lmdbUtility/initializePaths');
const system_schema = require('../../../../json/systemSchema.json');
const LMDB_ERRORS = require('../../../../utility/errors/commonErrors').LMDB_ERRORS_ENUM;
const { compareKeys } = require('ordered-binary');

const WILDCARDS = hdb_terms.SEARCH_WILDCARDS;


/**
 * gets the search_type & based on the size of the dbi being searched will either perform an in process search or launch a new process to perform a search
 * @param {SearchObject} search_object
 * @param {hdb_terms.VALUE_SEARCH_COMPARATORS} comparator
 * @param {Boolean} return_map
 * @returns {{}|[{}]}
 */
async function prepSearch(search_object, comparator, return_map) {
	let table_info;
	if (search_object.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
		table_info = system_schema[search_object.table];
	} else {
		table_info = global.hdb_schema[search_object.schema][search_object.table];
	}

	let search_type = createSearchTypeFromSearchObject(search_object, table_info.hash_attribute, return_map, comparator);

	return executeSearch(search_object, search_type, table_info.hash_attribute, return_map);
}

/**
 * executes a specific search based on the evaluation of the search_object & optional comparator & returns the results
 * @param {SearchObject} search_object
 * @param {lmdb_terms.SEARCH_TYPES} search_type
 * @param {String} hash_attribute
 * @param {Boolean} return_map
 */
async function executeSearch(search_object, search_type, hash_attribute, return_map) {
	let schema_path = path.join(getBaseSchemaPath(), search_object.schema.toString());
	let env = await environment_utility.openEnvironment(schema_path, search_object.table);
	let search_results = searchByType(env, search_object, search_type, hash_attribute);

	//if we execute a search all / search by hash type call there is no need to perform further evaluation as the records have been fetched
	if (
		[
			lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH,
			lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP,
			lmdb_terms.SEARCH_TYPES.SEARCH_ALL,
			lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP,
		].indexOf(search_type) >= 0
	) {
		return search_results;
	}

	let fetch_more = checkToFetchMore(search_object, hash_attribute);

	if (fetch_more === false) {
		return return_map === true ? createMapFromArrays(search_results) : search_results[1];
	}

	let ids = search_results[0];
	if (return_map === true) {
		return search_utility.batchSearchByHashToMap(env, hash_attribute, search_object.get_attributes, ids);
	}

	return search_utility.batchSearchByHash(env, hash_attribute, search_object.get_attributes, ids);

}

/**
 *
 * @param {lmdb.RootDatabase} env
 * @param {SearchObject} search_object
 * @param {lmdb_terms.SEARCH_TYPES} search_type
 * @param {String} hash_attribute
 * @returns {null|Array<Object>|Number|Object|*[]|{}}
 */
function searchByType(env, search_object, search_type, hash_attribute) {
	let search_results;

	//this is to conditionally not create the hash_attribute as part of the returned objects if it is not selected
	let hash_attribute_name = hash_attribute;
	if (search_object.get_attributes.indexOf(hash_attribute) < 0) {
		hash_attribute_name = undefined;
	}

	let { reverse, limit, offset } = search_object;
	reverse = typeof reverse === 'boolean' ? reverse : false;
	limit = Number.isInteger(limit) ? limit : undefined;
	offset = Number.isInteger(offset) ? offset : undefined;

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			search_results = search_utility.equals(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			search_results = search_utility.contains(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			search_results = search_utility.endsWith(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			search_results = search_utility.startsWith(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH:
			return search_utility.batchSearchByHash(env, search_object.search_attribute, search_object.get_attributes, [
				search_object.search_value,
			]);
		case lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP:
			return search_utility.batchSearchByHashToMap(env, search_object.search_attribute, search_object.get_attributes, [
				search_object.search_value,
			]);
		case lmdb_terms.SEARCH_TYPES.SEARCH_ALL:
			return search_utility.searchAll(env, hash_attribute, search_object.get_attributes, reverse, limit, offset);
		case lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP:
			return search_utility.searchAllToMap(env, hash_attribute, search_object.get_attributes, reverse, limit, offset);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			search_results = search_utility.between(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				search_object.end_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			search_results = search_utility.greaterThan(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			search_results = search_utility.greaterThanEqual(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			search_results = search_utility.lessThan(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			search_results = search_utility.lessThanEqual(
				env,
				hash_attribute_name,
				search_object.search_attribute,
				search_object.search_value,
				reverse,
				limit,
				offset
			);
			break;
		default:
			return Object.create(null);
	}

	return search_results;
}

/**
 *
 * @param {SearchObject} search_object
 * @returns {({}) => boolean}
 */
function filterByType(search_object) {
	const search_type = search_object.search_type;
	const attribute = search_object.search_attribute;
	const search_value = search_object.search_value;

	switch (search_type) {
		case lmdb_terms.SEARCH_TYPES.EQUALS:
			return (record) => record[attribute] === search_value;
		case lmdb_terms.SEARCH_TYPES.CONTAINS:
			return (record) => typeof record[attribute] === 'string' && record[attribute].includes(search_value);
		case lmdb_terms.SEARCH_TYPES.ENDS_WITH:
		case lmdb_terms.SEARCH_TYPES._ENDS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].endsWith(search_value);
		case lmdb_terms.SEARCH_TYPES.STARTS_WITH:
		case lmdb_terms.SEARCH_TYPES._STARTS_WITH:
			return (record) => typeof record[attribute] === 'string' && record[attribute].startsWith(search_value);
		case lmdb_terms.SEARCH_TYPES.BETWEEN:
			return (record) => {
				let value = record[attribute];
				return compareKeys(value, search_value[0]) >= 0 && compareKeys(value, search_value[1]) <= 0;
			};
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN:
			return (record) => compareKeys(record[attribute], search_value) > 0;
		case lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._GREATER_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], search_value) >= 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN:
			return (record) => compareKeys(record[attribute], search_value) < 0;
		case lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL:
		case lmdb_terms.SEARCH_TYPES._LESS_THAN_EQUAL:
			return (record) => compareKeys(record[attribute], search_value) <= 0;
		default:
			return Object.create(null);
	}
}




/**
 *
 * @param {[[],[]]}arrays
 */
function createMapFromArrays(arrays) {
	let results = Object.create(null);

	for (let x = 0, length = arrays[0].length; x < length; x++) {
		results[arrays[0][x]] = arrays[1][x];
	}
	return results;
}

/**
 *
 * @param {SearchObject} search_object
 * @param {String} hash_attribute
 */
function checkToFetchMore(search_object, hash_attribute) {
	if (search_object.get_attributes.length === 1 && search_object.get_attributes[0] === '*') {
		return true;
	}
	let already_fetched_attributes = [search_object.search_attribute];
	if (search_object.get_attributes.indexOf(hash_attribute) >= 0) {
		already_fetched_attributes.push(hash_attribute);
	}

	let fetch_more = false;
	for (let x = 0; x < search_object.get_attributes.length; x++) {
		if (already_fetched_attributes.indexOf(search_object.get_attributes[x]) < 0) {
			fetch_more = true;
			break;
		}
	}

	return fetch_more;
}

/**
 * evaluates the search_object to determine what the search_type needs to be for later execution of queries
 * @param {SearchObject} search_object
 * @param {String} hash_attribute
 * @param {hdb_terms.VALUE_SEARCH_COMPARATORS} comparator
 * @param {Boolean} return_map
 * @returns {lmdb_terms.SEARCH_TYPES}
 */
function createSearchTypeFromSearchObject(search_object, hash_attribute, return_map, comparator) {
	if (common_utils.isEmpty(comparator)) {
		let search_value = search_object.search_value;
		if (typeof search_value === 'object') {
			search_value = JSON.stringify(search_value);
		} else {
			search_value = search_value.toString();
		}

		let first_search_character = search_value.charAt(0);
		let last_search_character = search_value.charAt(search_value.length - 1);
		let hash_search = false;
		if (search_object.search_attribute === hash_attribute) {
			hash_search = true;
		}

		if (WILDCARDS.indexOf(search_value) > -1) {
			return return_map === true ? lmdb_terms.SEARCH_TYPES.SEARCH_ALL_TO_MAP : lmdb_terms.SEARCH_TYPES.SEARCH_ALL;
		}

		if (search_value.indexOf(WILDCARDS[0]) < 0 && search_value.indexOf(WILDCARDS[1]) < 0) {
			if (hash_search === true) {
				return return_map === true
					? lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH_TO_MAP
					: lmdb_terms.SEARCH_TYPES.BATCH_SEARCH_BY_HASH;
			}

			return lmdb_terms.SEARCH_TYPES.EQUALS;
		}

		if (WILDCARDS.indexOf(first_search_character) >= 0 && WILDCARDS.indexOf(last_search_character) >= 0) {
			//this removes the first  & last character from the search value
			search_object.search_value = search_object.search_value.slice(1, -1);
			return lmdb_terms.SEARCH_TYPES.CONTAINS;
		}

		if (WILDCARDS.indexOf(first_search_character) >= 0) {
			search_object.search_value = search_object.search_value.substr(1);
			return lmdb_terms.SEARCH_TYPES.ENDS_WITH;
		}

		if (WILDCARDS.indexOf(last_search_character) >= 0) {
			search_object.search_value = search_object.search_value.slice(0, -1);
			return lmdb_terms.SEARCH_TYPES.STARTS_WITH;
		}

		if (search_value.includes(WILDCARDS[0]) || search_value.includes(WILDCARDS[1])) {
			return lmdb_terms.SEARCH_TYPES.EQUALS;
		}

		throw new Error(LMDB_ERRORS.UNKNOWN_SEARCH_TYPE);
	} else {
		switch (comparator) {
			case hdb_terms.VALUE_SEARCH_COMPARATORS.BETWEEN:
				return lmdb_terms.SEARCH_TYPES.BETWEEN;
			case hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER:
				return lmdb_terms.SEARCH_TYPES.GREATER_THAN;
			case hdb_terms.VALUE_SEARCH_COMPARATORS.GREATER_OR_EQ:
				return lmdb_terms.SEARCH_TYPES.GREATER_THAN_EQUAL;
			case hdb_terms.VALUE_SEARCH_COMPARATORS.LESS:
				return lmdb_terms.SEARCH_TYPES.LESS_THAN;
			case hdb_terms.VALUE_SEARCH_COMPARATORS.LESS_OR_EQ:
				return lmdb_terms.SEARCH_TYPES.LESS_THAN_EQUAL;
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
	filterByType,
};
