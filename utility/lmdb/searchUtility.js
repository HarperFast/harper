'use strict';

const environment_utility = require('./environmentUtility');

const log = require('../logging/harper_logger');
const common = require('./commonUtility');
const lmdb_terms = require('./terms');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const hdb_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const cursor_functions = require('./searchCursorFunctions');
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdb_terms;
const LAZY_PROPERTY_ACCESS = { lazy: true };

/** UTILITY CURSOR FUNCTIONS **/

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Function} eval_function
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]}
 */
function iterateFullIndex(
	env,
	hash_attribute,
	attribute,
	eval_function,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	let results = Object.create(null);

	let dbi = environment_utility.openDBI(env, attribute);
	if (dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	}
	const overflowCheck = getOverflowCheck(env, hash_attribute, attribute);

	for (let { key, value } of dbi.getRange({
		start: reverse ? undefined : false,
		end: !reverse ? undefined : false,
		limit: limit,
		offset: offset,
		reverse: reverse,
	})) {
		eval_function(overflowCheck(key, value), value, results, hash_attribute, attribute);
	}
	return results;
}

/**
 * Creates the basis for a forward/reverse range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {Function} eval_function
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function iterateRangeNext(
	env,
	hash_attribute,
	attribute,
	search_value,
	eval_function,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	let results = [[], []];

	let dbi = environment_utility.openDBI(env, attribute);
	if (dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	}

	//because reversing only returns 1 entry from a dup sorted key we get all entries for the search value
	let start_value = reverse === true ? undefined : search_value === undefined ? false : search_value;
	let end_value = reverse === true ? search_value : undefined;
	const overflowCheck = getOverflowCheck(env, hash_attribute, attribute);

	for (let { key, value } of dbi.getRange({ start: start_value, end: end_value, reverse, limit, offset })) {
		eval_function(search_value, overflowCheck(key, value), value, results, hash_attribute, attribute);
	}

	return results;
}

/**
 * specific iterator function for perfroming betweens on numeric columns
 * for this function specifically it is important to remember that the buffer representations of numbers are stored in the following order:
 * 0,1,2,3,4,5,6.....1000,-1,-2,-3,-4,-5,-6....-1000
 * as such we need to do some work with the cursor in order to move to the point we need depending on the type of range we are searching.
 * another important point to remember is the search is always iterating forward.  this makes sense for positive number searches,
 * but get wonky for negative number searches and especially for a range of between -4 & 6.  the reason is we will start the iterator at 0, move forward to 6,
 * then we need to jump forward to the highest negative number and stop at the start of our range (-4).
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Number|String} lower_value
 * @param {Number|String} upper_value
 * @param {boolean} reverse
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function iterateRangeBetween(
	env,
	hash_attribute,
	attribute,
	lower_value,
	upper_value,
	reverse = false,
	limit = undefined,
	offset = undefined,
	exclusive_lower = false,
	exclusive_upper = false
) {
	let results = [[], []];

	let attr_dbi = environment_utility.openDBI(env, attribute); // verify existence of the attribute
	const overflowCheck =  getOverflowCheck(env, hash_attribute, attribute);
	if (attr_dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	}

	let end = reverse === true ? lower_value : upper_value;
	let start = reverse === true ? upper_value : lower_value;
	let inclusive_end = reverse === true ? !exclusive_lower : !exclusive_upper;
	let exclusive_start = reverse === true ? exclusive_upper : exclusive_lower;

	for (let { key, value } of attr_dbi.getRange({
		start,
		end,
		reverse,
		limit,
		offset,
		inclusiveEnd: inclusive_end,
		exclusiveStart: exclusive_start,
	})) {
		cursor_functions.pushResults(overflowCheck(key, value), value, results, hash_attribute, attribute);
	}
	return results;
}

function getOverflowCheck(env, hash_attribute, attribute) {
	let primary_dbi;
	return function(key, value) {
		if (typeof key === 'string' && key.endsWith(OVERFLOW_MARKER)) {
			// the entire value couldn't be encoded because it was too long, so need to search the attribute from
			// the original record.
			// first get the hash/primary dbi
			if (!primary_dbi) {
				// only have to open once per search
				if (hash_attribute) primary_dbi = environment_utility.openDBI(env, hash_attribute);
				else {
					// not sure how often this gets called without a hash_attribute, as this would be kind of expensive
					// if done frequently
					let dbis = environment_utility.listDBIs(env);
					for (let i = 0, l = dbis.length; i < l; i++) {
						primary_dbi = environment_utility.openDBI(env, dbis[i]);
						if (primary_dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) break;
					}
				}
			}
			let record = primary_dbi.get(value, LAZY_PROPERTY_ACCESS);
			key = record[attribute];
		}
		return key;
	}
}

/**
 * iterates the entire  hash_attribute dbi and returns all objects back
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @returns {Array.<Object>} - object array of fetched records
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 */
function searchAll(env, hash_attribute, fetch_attributes, reverse = false, limit = undefined, offset = undefined) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);
	fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);

	let results = [];

	let dbi = environment_utility.openDBI(env, hash_attribute);

	for (let { key, value } of dbi.getRange({
		start: reverse ? undefined : false,
		end: !reverse ? undefined : false,
		limit: limit,
		offset: offset,
		reverse: reverse,
	})) {
		cursor_functions.searchAll(fetch_attributes, key, value, results);
	}
	return results;
}

/**
* iterates the entire  hash_attribute dbi and returns all objects back in a map
* @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
* @param {String} hash_attribute - name of the hash_attribute for this environment
* @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
* @returns {{String|Number, Object}} - object array of fetched records

*/
function searchAllToMap(env, hash_attribute, fetch_attributes, reverse = false, limit = undefined, offset = undefined) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);
	fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);
	return iterateFullIndex(
		env,
		hash_attribute,
		hash_attribute,
		cursor_functions.searchAllToMap.bind(null, fetch_attributes),
		reverse,
		limit,
		offset
	);
}

/**
 * iterates a dbi and returns the key/value pairing for each entry
 * @param env
 * @param attribute
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {Array.<Array>}
 */
function iterateDBI(env, attribute, reverse = false, limit = undefined, offset = undefined) {
	common.validateEnv(env);
	if (attribute === undefined) {
		throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
	}

	return iterateFullIndex(env, undefined, attribute, cursor_functions.iterateDBI, reverse, limit, offset);
}

/**
 * counts all records in an environment based on the count from stating the hash_attribute  dbi
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @returns {number} - number of records in the environment
 */
function countAll(env, hash_attribute) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	let stat = environment_utility.statDBI(env, hash_attribute);
	return stat.entryCount;
}

/**
 * performs an equal search on the key of a named dbi, returns a list of ids where their keys literally match the search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function equals(env, hash_attribute, attribute, search_value, reverse = false, limit = undefined, offset = undefined) {
	validateComparisonFunctions(env, attribute, search_value);

	let dbi = environment_utility.openDBI(env, attribute);

	search_value = common.convertKeyValueToWrite(search_value);

	let results = [[], []];
	if (dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
		let value = dbi.get(search_value, LAZY_PROPERTY_ACCESS);
		if (value !== undefined) {
			cursor_functions.pushResults(search_value, value, results, hash_attribute, attribute);
		}
	} else {
		for (let value of dbi.getValues(search_value, { reverse, limit, offset })) {
			cursor_functions.pushResults(search_value, value, results, hash_attribute, attribute);
		}
	}
	return results;
}

/**
 * Counts the number of entries for a key of a named dbi, returning the count
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
*/
function count(env, attribute, search_value) {
	validateComparisonFunctions(env, attribute, search_value);

	let dbi = environment_utility.openDBI(env, attribute);
	return dbi.getValuesCount(search_value);
}

/**
 * performs an startsWith search on the key of a named dbi, returns a list of ids where their keys begin with the search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function startsWith(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(env, attribute, search_value);

	let results = [[], []];

	let dbi = environment_utility.openDBI(env, attribute);

	if (dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	}

	//if the search is numeric we need to scan the entire index, if string we can just do a range
	search_value = common.convertKeyValueToWrite(search_value);
	let string_search = true;
	if (typeof search_value === 'number') {
		string_search = false;
	}

	//if we are reversing we need to get the key after the one we want to search on so we can start there and iterate to the front
	if (reverse === true) {
		let next_key;
		//iterate based on the search_value until the key no longer starts with the search_value, this is the key we need to start with in the search
		for (let key of dbi.getKeys({ start: search_value })) {
			if (!key.startsWith(search_value)) {
				next_key = key;
				break;
			}
		}

		//with the new search value we iterate
		if (next_key !== undefined) {
			if (Number.isInteger(offset)) {
				offset++;
			} else {
				limit++;
			}
		}

		for (let { key, value } of dbi.getRange({ start: next_key, end: undefined, reverse, limit, offset })) {
			if (key === next_key) {
				continue;
			}

			if (key.toString().startsWith(search_value)) {
				cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
			} else if (string_search === true) {
				break;
			}
		}
	} else {
		for (let { key, value } of dbi.getRange({ start: search_value, reverse, limit, offset })) {
			if (key.toString().startsWith(search_value)) {
				cursor_functions.pushResults(key, value, results, hash_attribute, attribute);
			} else if (string_search === true) {
				break;
			}
		}
	}
	return results;
}

/**
 * performs an endsWith search on the key of a named dbi, returns a list of ids where their keys end with search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function endsWith(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	return contains(env, hash_attribute, attribute, search_value, reverse, limit, offset, true);
}

/**
 * performs a contains search on the key of a named dbi, returns a list of ids where their keys contain the search_value
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param {String|Number} search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @param {boolean} ends_with - Must only contain this value at the end
 * @returns {[[],[]]} - ids matching the search
 */
function contains(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined,
	ends_with = false
) {
	validateComparisonFunctions(env, attribute, search_value);

	let results = [[], []];
	let attr_dbi = environment_utility.openDBI(env, attribute); // verify existence of the attribute
	if (attr_dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	}
	const overflowCheck = getOverflowCheck(env, hash_attribute, attribute);

	offset = Number.isInteger(offset) ? offset : 0;
	for (let key of attr_dbi.getKeys({ end: reverse ? false : undefined, reverse })) {
		if (limit === 0) {
			break;
		}

		let found_str = key.toString();
		if (found_str.endsWith(OVERFLOW_MARKER)) {
			// the entire value couldn't be encoded because it was too long, so need to search the attributes from
			// the original record
			for (let primary_key of attr_dbi.getValues(key)) {
				// this will get the full value from each entire record so we can check it
				let full_key = overflowCheck(key, primary_key);
				if (ends_with ? full_key.endsWith(search_value) : full_key.includes(search_value)) {
					found_match(full_key, primary_key);
				}
			}
		} else if (ends_with ? found_str.endsWith(search_value) : found_str.includes(search_value)) {
			if (attr_dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute)
				found_match(key, key);
			else {
				for (let primary_key of attr_dbi.getValues(key)) {
					found_match(key, primary_key);
				}
			}
		}
	}
	function found_match(key, primary_key) {
		if (offset > 0) {
			offset--;
			return;
		}
		if (limit === 0) {
			return;
		}

		cursor_functions.pushResults(key, primary_key, results, hash_attribute, attribute);
		limit--;
	}

	return results;
}

/** RANGE FUNCTIONS **/

/**
 * performs a greater than search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function greaterThan(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(env, attribute, search_value);

	let type = typeof search_value;
	let upper_value;
	if (type === 'string')
		upper_value = '\uffff';
	else if (type === 'number')
		upper_value = Infinity;
	else if (type === 'boolean')
		upper_value = true;
	return iterateRangeBetween(
		env,
		hash_attribute,
		attribute,
		search_value,
		upper_value,
		reverse,
		limit,
		offset,
		true,
		false
	);
}

/**
 * performs a greater than equal search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function greaterThanEqual(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(env, attribute, search_value);

	let type = typeof search_value;
	let upper_value;
	if (type === 'string')
		upper_value = '\uffff';
	else if (type === 'number')
		upper_value = Infinity;
	else if (type === 'boolean')
		upper_value = true;
	return iterateRangeBetween(
		env,
		hash_attribute,
		attribute,
		search_value,
		upper_value,
		reverse,
		limit,
		offset,
		false,
		false
	);
}

/**
 * performs a less than search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function lessThan(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(env, attribute, search_value);
	let type = typeof search_value;
	let lower_value;
	if (type === 'string')
		lower_value = '\x00';
	else if (type === 'number')
		lower_value = -Infinity;
	else if (type === 'boolean')
		lower_value = false;
	return iterateRangeBetween(
		env,
		hash_attribute,
		attribute,
		lower_value,
		search_value,
		reverse,
		limit,
		offset,
		false,
		true
	);
}

/**
 * performs a less than equal search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - defines the direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function lessThanEqual(
	env,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(env, attribute, search_value);
	let type = typeof search_value;
	let lower_value;
	if (type === 'string')
		lower_value = '\x00';
	else if (type === 'number')
		lower_value = -Infinity;
	else if (type === 'boolean')
		lower_value = false;
	return iterateRangeBetween(
		env,
		hash_attribute,
		attribute,
		lower_value,
		search_value,
		reverse,
		limit,
		offset,
		false,
		false
	);
}

/**
 * performs a between search for string / numeric search value
 * @param {lmdb.RootDatabase} env
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} start_value
 * @param {String|Number}end_value
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function between(
	env,
	hash_attribute,
	attribute,
	start_value,
	end_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(env);

	if (attribute === undefined) {
		throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
	}

	if (start_value === undefined) {
		throw new Error(LMDB_ERRORS.START_VALUE_REQUIRED);
	}

	if (end_value === undefined) {
		throw new Error(LMDB_ERRORS.END_VALUE_REQUIRED);
	}

	start_value = common.convertKeyValueToWrite(start_value);
	end_value = common.convertKeyValueToWrite(end_value);
	if (start_value > end_value) {
		throw new Error(LMDB_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE);
	}

	return iterateRangeBetween(env, hash_attribute, attribute, start_value, end_value, reverse, limit, offset);
}

/**
 * finds a single record based on the id passed
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {String} id - id value to search
 * @returns {{}} - object found
 */
function searchByHash(env, hash_attribute, fetch_attributes, id) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);
	fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);
	if (id === undefined) {
		throw new Error(LMDB_ERRORS.ID_REQUIRED);
	}

	let obj = null;
	let object = env.dbis[hash_attribute].get(id, fetch_attributes.length < 3 ? LAZY_PROPERTY_ACCESS : undefined);

	if (object) {
		obj = cursor_functions.parseRow(object, fetch_attributes);
	}
	return obj;
}

/**
 * checks if a hash value exists based on the id passed
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {String|Number} id - id value to check exists
 * @returns {boolean} - whether the hash exists (true) or not (false)
 */
function checkHashExists(env, hash_attribute, id) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	if (id === undefined) {
		throw new Error(LMDB_ERRORS.ID_REQUIRED);
	}

	let found_key = true;

	let value = env.dbis[hash_attribute].get(id, LAZY_PROPERTY_ACCESS);

	if (value === undefined) {
		found_key = false;
	}
	return found_key;
}

/**
 * finds an array of records based on the ids passed
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Array.<Object>} - object array of records found
 */
function batchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found = []) {
	initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

	let results = batchHashSearch(env, hash_attribute, fetch_attributes, ids, not_found);

	return Object.values(results);
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {{}} - object array of records found
 */
function batchSearchByHashToMap(env, hash_attribute, fetch_attributes, ids, not_found = []) {
	initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found);

	return batchHashSearch(env, hash_attribute, fetch_attributes, ids, not_found);
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Object}
 */
function batchHashSearch(env, hash_attribute, fetch_attributes, ids, not_found = []) {
	fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);

	let results = Object.create(null);
	let get_options = fetch_attributes.length < 3 ? LAZY_PROPERTY_ACCESS : undefined;

	for (let x = 0; x < ids.length; x++) {
		let id = ids[x];
		try {
			let object = env.dbis[hash_attribute].get(id, get_options);
			if (object) {
				let obj = cursor_functions.parseRow(object, fetch_attributes);
				results[id] = obj;
			} else {
				not_found.push(id);
			}
		} catch (e) {
			log.warn(e);
			throw e;
		}
	}

	return results;
}

/**
 * function used to intialize the batchSearchByHash functions
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] -optional,  meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {TransactionCursor}
 */
function initializeBatchSearchByHash(env, hash_attribute, fetch_attributes, ids, not_found) {
	common.validateEnv(env);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);

	if (!Array.isArray(ids)) {
		if (ids === undefined) {
			throw new Error(LMDB_ERRORS.IDS_REQUIRED);
		}

		throw new Error(LMDB_ERRORS.IDS_MUST_BE_ARRAY);
	}

	if (!Array.isArray(not_found)) {
		not_found = [];
	}
}

/**
 * validates the fetch_attributes argument
 * @param fetch_attributes - string array of attributes to pull from the object
 */
function validateFetchAttributes(fetch_attributes) {
	if (!Array.isArray(fetch_attributes)) {
		if (fetch_attributes === undefined) {
			throw new Error(LMDB_ERRORS.FETCH_ATTRIBUTES_REQUIRED);
		}
		throw new Error(LMDB_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY);
	}
}

/**
 * common validation function for all of the comparison searches (equals, startsWith, endsWith, contains)
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 * @param attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 */
function validateComparisonFunctions(env, attribute, search_value) {
	common.validateEnv(env);
	if (attribute === undefined) {
		throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
	}

	if (search_value === undefined) {
		throw new Error(LMDB_ERRORS.SEARCH_VALUE_REQUIRED);
	}

	if (search_value?.length > MAX_SEARCH_KEY_LENGTH) {
		throw new Error(LMDB_ERRORS.SEARCH_VALUE_TOO_LARGE);
	}
}

/**
 * determines if the intent is to return the whole row based on fetch_attributes having 1 entry that is wildcard * or %
 * @param env
 * @param fetch_attributes
 * @returns {Array}
 */
function setGetWholeRowAttributes(env, fetch_attributes) {
	if (fetch_attributes.length === 1 && hdb_terms.SEARCH_WILDCARDS.indexOf(fetch_attributes[0]) >= 0) {
		fetch_attributes = environment_utility.listDBIs(env);
	}

	return fetch_attributes;
}

module.exports = {
	searchAll,
	searchAllToMap,
	count,
	countAll,
	equals,
	startsWith,
	endsWith,
	contains,
	searchByHash,
	setGetWholeRowAttributes,
	batchSearchByHash,
	batchSearchByHashToMap,
	checkHashExists,
	iterateDBI,
	greaterThan,
	greaterThanEqual,
	lessThan,
	lessThanEqual,
	between,
};
