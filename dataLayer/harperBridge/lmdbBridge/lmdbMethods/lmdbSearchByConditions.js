'use strict';

const SearchByConditionsObject = require('../../../SearchByConditionsObject.js').SearchByConditionsObject;
const SearchObject = require('../../../SearchObject.js');
const searchValidator = require('../../../../validation/searchValidator.js');
const searchUtility = require('../../../../utility/lmdb/searchUtility.js');
const lmdbTerms = require('../../../../utility/lmdb/terms.js');
const { Resource } = require('../../../../resources/Resource.ts');
const lmdb_search = require('../lmdbUtility/lmdbSearch.js');
const cursorFunctions = require('../../../../utility/lmdb/searchCursorFunctions.js');
const _ = require('lodash');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const { handleHDBError, hdbErrors } = require('../../../../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const RANGE_ESTIMATE = 100000000;

module.exports = lmdbSearchByConditions;

/**
 * gets records by conditions - returns array of Objects
 * @param {SearchByConditionsObject} searchObject
 * @returns {Array.<Object>}
 */
async function lmdbSearchByConditions(searchObject) {
	let validationError = searchValidator(searchObject, 'conditions');
	if (validationError) {
		throw handleHDBError(
			validationError,
			validationError.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	//set the operator to always be lowercase for later evaluations
	searchObject.operator = searchObject.operator ? searchObject.operator.toLowerCase() : undefined;

	searchObject.offset = Number.isInteger(searchObject.offset) ? searchObject.offset : 0;
	let schemaPath = getSchemaPath(searchObject.schema, searchObject.table);
	let env = await environmentUtility.openEnvironment(schemaPath, searchObject.table);

	const tableInfo = global.hdb_schema[searchObject.schema][searchObject.table];

	// make sure the dbis have been opened prior to the read transaction starting
	for (let condition of searchObject.conditions) {
		environmentUtility.openDBI(env, condition.search_attribute);
	}
	// Sort the conditions by narrowest to broadest. Note that we want to do this both for intersection where
	// it allows us to do minimal filtering, and for union where we can return the fastest results first
	// in an iterator/stream.
	let sortedConditions = _.sortBy(searchObject.conditions, (condition) => {
		if (condition.estimated_count === undefined) {
			// skip if it is cached
			let searchType = condition.search_type;
			if (searchType === lmdbTerms.SEARCH_TYPES.EQUALS)
				// we only attempt to estimate count on equals operator because that's really all that LMDB supports (some other key-value stores like libmdbx could be considered if we need to do estimated counts of ranges at some point)
				condition.estimated_count = searchUtility.count(env, condition.search_attribute, condition.search_value);
			else if (searchType === lmdbTerms.SEARCH_TYPES.CONTAINS || searchType === lmdbTerms.SEARCH_TYPES.ENDS_WITH)
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
	let ids = await executeConditionSearch(transaction, searchObject, sortedConditions[0], tableInfo.hash_attribute);
	// and then things diverge...
	let records;
	if (!searchObject.operator || searchObject.operator.toLowerCase() === 'and') {
		// get the intersection of condition searches by using the indexed query for the first condition
		// and then filtering by all subsequent conditions
		let primaryDbi = env.dbis[tableInfo.hash_attribute];
		let filters = sortedConditions.slice(1).map(lmdb_search.filterByType);
		let filtersLength = filters.length;
		let fetchAttributes = searchUtility.setGetWholeRowAttributes(env, searchObject.get_attributes);
		records = ids.map((id) => primaryDbi.get(id, { transaction, lazy: true }));
		if (filtersLength > 0)
			records = records.filter((record) => {
				for (let i = 0; i < filtersLength; i++) {
					if (!filters[i](record)) return false; // didn't match filters
				}
				return true;
			});
		if (searchObject.offset || searchObject.limit !== undefined)
			records = records.slice(
				searchObject.offset,
				searchObject.limit !== undefined ? (searchObject.offset || 0) + searchObject.limit : undefined
			);
		records = records.map((record) => cursorFunctions.parseRow(record, fetchAttributes));
	} else {
		//get the union of ids from all condition searches
		for (let i = 1; i < sortedConditions.length; i++) {
			let condition = sortedConditions[i];
			// might want to lazily execute this after getting to this point in the iteration
			let nextIds = await executeConditionSearch(transaction, searchObject, condition, tableInfo.hash_attribute);
			ids = ids.concat(nextIds);
		}
		let returnedIds = new Set();
		let offset = searchObject.offset || 0;
		ids = ids
			.filter((id) => {
				if (returnedIds.has(id))
					// skip duplicates
					return false;
				returnedIds.add(id);
				return true;
			})
			.slice(offset, searchObject.limit && searchObject.limit + offset);
		records = searchUtility.batchSearchByHash(
			transaction,
			tableInfo.hash_attribute,
			searchObject.get_attributes,
			ids
		);
	}
	records.onDone = () => {
		transaction.done(); // need to complete the transaction once iteration is complete
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
 * @param {SearchByConditionsObject} searchObject
 * @param {String} hash_attribute
 * @returns {Promise<unknown[]>}
 */
// eslint-disable-next-line require-await
async function executeConditionSearch(transaction, searchObject, condition, hash_attribute) {
	//build a prototype object for search
	let search = new SearchObject(
		searchObject.schema,
		searchObject.table,
		undefined,
		undefined,
		hash_attribute,
		searchObject.get_attributes
	);

	//execute conditional search
	let searchType = condition.search_type;
	search.search_attribute = condition.search_attribute;

	if (searchType === lmdbTerms.SEARCH_TYPES.BETWEEN) {
		search.search_value = condition.search_value[0];
		search.end_value = condition.search_value[1];
	} else {
		search.search_value = condition.search_value;
	}
	return lmdb_search.searchByType(transaction, search, searchType, hash_attribute).map((e) => e.value);
}
