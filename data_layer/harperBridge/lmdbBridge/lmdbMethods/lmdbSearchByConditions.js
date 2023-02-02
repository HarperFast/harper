'use strict';

const SearchByConditionsObject = require('../../../SearchByConditionsObject').SearchByConditionsObject;
const SearchObject = require('../../../SearchObject');
const search_validator = require('../../../../validation/searchValidator');
const search_utility = require('../../../../utility/lmdb/searchUtility');
const lmdb_terms = require('../../../../utility/lmdb/terms');
const lmdb_search = require('../lmdbUtility/lmdbSearch');
const cursor_functions = require('../../../../utility/lmdb/searchCursorFunctions');
const _ = require('lodash');
const { getBaseSchemaPath } = require('../lmdbUtility/initializePaths');
const path = require('path');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const RANGE_ESTIMATE = 100000000;
const LAZY_PROPERTY_ACCESS = { lazy: true };

module.exports = lmdbSearchByConditions;

/**
 * gets records by conditions - returns array of Objects
 * @param {SearchByConditionsObject} search_object
 * @returns {Array.<Object>}
 */
async function lmdbSearchByConditions(search_object) {
	let validation_error = search_validator(search_object, 'conditions');
	if (validation_error) {
		throw handleHDBError(
			validation_error,
			validation_error.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	//set the operator to always be lowercase for later evaluations
	search_object.operator = search_object.operator ? search_object.operator.toLowerCase() : undefined;

	search_object.offset = Number.isInteger(search_object.offset) ? search_object.offset : 0;

	let schema_path = path.join(getBaseSchemaPath(), search_object.schema.toString());
	let env = await environment_utility.openEnvironment(schema_path, search_object.table);

	const table_info = global.hdb_schema[search_object.schema][search_object.table];

	// make sure the dbis have been opened prior to the read transaction starting
	for (let condition of search_object.conditions) {
		environment_utility.openDBI(env, condition.search_attribute);
	}
	// Sort the conditions by narrowest to broadest. Note that we want to do this both for intersection where
	// it allows us to do minimal filtering, and for union where we can return the fastest results first
	// in an iterator/stream.
	let sorted_conditions = _.sortBy(search_object.conditions, (condition) => {
		if (condition.estimated_count === undefined) {
			// skip if it is cached
			let search_type = condition.search_type;
			if (search_type === lmdb_terms.SEARCH_TYPES.EQUALS)
				// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
				condition.estimated_count = search_utility.count(env, condition.search_attribute, condition.search_value);
			else if (search_type === lmdb_terms.SEARCH_TYPES.CONTAINS || search_type === lmdb_terms.SEARCH_TYPES.ENDS_WITH)
				condition.estimated_count = Infinity;
			// this search types can't/doesn't use indices, so try do them last
			// for range queries (betweens, starts-with, greater, etc.), just arbitrarily guess
			else condition.estimated_count = RANGE_ESTIMATE;
		}
		return condition.estimated_count; // use cached count
	});
	// we create the read transaction after ensuring that the dbis have been opened (necessary for a stable read
	// transaction, and we really don't care if the
	// counts are done in the same read transaction because they are just estimates.
	let transaction = env.useReadTransaction();
	transaction.database = env;
	// both AND and OR start by getting an iterator for the ids for first condition
	let ids = await executeConditionSearch(transaction, search_object, sorted_conditions[0], table_info.hash_attribute);
	// and then things diverge...
	let records;
	if (!search_object.operator || search_object.operator.toLowerCase() === 'and') {
		// get the intersection of condition searches by using the indexed query for the first condition
		// and then filtering by all subsequent conditions
		let primary_dbi = env.dbis[table_info.hash_attribute];
		let filters = sorted_conditions.slice(1).map(lmdb_search.filterByType);
		let filters_length = filters.length;
		let fetch_attributes = search_utility.setGetWholeRowAttributes(env, search_object.get_attributes);
		records = ids.map((id) => primary_dbi.get(id, { transaction, lazy: true }));
		if (filters_length > 0)
			records = records.filter((record) => {
				for (let i = 0; i < filters_length; i++) {
					if (!filters[i](record)) return false; // didn't match filters
				}
				return true;
			});
		if (search_object.offset || search_object.limit !== undefined)
			records = records.slice(
				search_object.offset,
				search_object.limit !== undefined ? (search_object.offset || 0) + search_object.limit : undefined
			);
		records = records.map((record) => cursor_functions.parseRow(record, fetch_attributes));
	} else {
		//get the union of ids from all condition searches
		for (let i = 1; i < sorted_conditions.length; i++) {
			let condition = sorted_conditions[i];
			// might want to lazily execute this after getting to this point in the iteration
			let next_ids = await executeConditionSearch(transaction, search_object, condition, table_info.hash_attribute);
			ids = ids.concat(next_ids);
		}
		let returned_ids = new Set();
		let offset = search_object.offset || 0;
		ids = ids
			.filter((id) => {
				if (returned_ids.has(id))
					// skip duplicates
					return false;
				returned_ids.add(id);
				return true;
			})
			.slice(offset, search_object.limit && search_object.limit + offset);
		records = search_utility.batchSearchByHash(transaction, table_info.hash_attribute, search_object.get_attributes, ids);
	}
	records.onDone = () => {
		transaction.done();// need to complete the transaction once iteration is complete
	};
	return records;
}

/**
 * This function sorts an array ascending, the sort checks if either element is not a number.  if not a number they are both set to strings to compare them properly as a string will not compare to a number natively
 * @param a
 * @param b
 * @returns {number}
 */
function sorter(a, b) {
	if (isNaN(a) || isNaN(b)) {
		a = a.toString();
		b = b.toString();
	}

	if (a > b) {
		return 1;
	} else if (b > a) {
		return -1;
	}
	return 0;
}
/**
 *
 * @param transaction
 * @param {SearchByConditionsObject} search_object
 * @param {String} hash_attribute
 * @returns {Promise<unknown[]>}
 */
// eslint-disable-next-line require-await
async function executeConditionSearch(transaction, search_object, condition, hash_attribute) {
	//build a prototype object for search
	let search = new SearchObject(
		search_object.schema,
		search_object.table,
		undefined,
		undefined,
		hash_attribute,
		search_object.get_attributes
	);

	//execute conditional search
	let search_type = condition.search_type;
	search.search_attribute = condition.search_attribute;

	if (search_type === lmdb_terms.SEARCH_TYPES.BETWEEN) {
		search.search_value = condition.search_value[0];
		search.end_value = condition.search_value[1];
	} else {
		search.search_value = condition.search_value;
	}
	return lmdb_search.searchByType(transaction, search, search_type, hash_attribute).map(e => e.value);
}
