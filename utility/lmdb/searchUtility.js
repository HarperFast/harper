'use strict';

const environment_utility = require('./environmentUtility');

const log = require('../logging/harper_logger');
const common = require('./commonUtility');
const lmdb_terms = require('./terms');
const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
const hdb_utils = require('../common_utils');
const hdb_terms = require('../hdbTerms');
const cursor_functions = require('./searchCursorFunctions');
const { parseRow } = cursor_functions;
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdb_terms;
const LAZY_PROPERTY_ACCESS = { lazy: true };

/** UTILITY CURSOR FUNCTIONS **/

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Function} eval_function
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[]}
 */
function iterateFullIndex(
	transactionOrEnv,
	hash_attribute,
	attribute,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, dbi) => {
		return dbi.getRange({
			transaction,
			start: reverse ? undefined : false,
			end: !reverse ? undefined : false,
			limit: limit,
			offset: offset,
			reverse: reverse,
		});
	});
}

/**
 * Creates the basis for a forward/reverse range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Transaction} transaction
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
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	eval_function,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, dbi, env, hash_attribute) => {
		const overflow_check = getOverflowCheck(env, transaction, hash_attribute, attribute);
		let results = [[], []];
		//because reversing only returns 1 entry from a dup sorted key we get all entries for the search value
		let start_value = reverse === true ? undefined : search_value === undefined ? false : search_value;
		let end_value = reverse === true ? search_value : undefined;

		for (let { key, value } of dbi.getRange({
			transaction,
			start: start_value,
			end: end_value,
			reverse,
			limit,
			offset,
		})) {
			eval_function(search_value, overflow_check(key, value), value, results, hash_attribute, attribute);
		}

		return results;
	});
}

/**
 * specific iterator function for perfroming betweens on numeric columns
 * for this function specifically it is important to remember that the buffer representations of numbers are stored in the following order:
 * 0,1,2,3,4,5,6.....1000,-1,-2,-3,-4,-5,-6....-1000
 * as such we need to do some work with the cursor in order to move to the point we need depending on the type of range we are searching.
 * another important point to remember is the search is always iterating forward.  this makes sense for positive number searches,
 * but get wonky for negative number searches and especially for a range of between -4 & 6.  the reason is we will start the iterator at 0, move forward to 6,
 * then we need to jump forward to the highest negative number and stop at the start of our range (-4).
 * @param {TableTransaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Number|String} lower_value
 * @param {Number|String} upper_value
 * @param {boolean} reverse
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {Iterable}
 */
function iterateRangeBetween(
	transactionOrEnv,
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
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, attr_dbi, env, hash_attribute) => {
		let end = reverse === true ? lower_value : upper_value;
		let start = reverse === true ? upper_value : lower_value;
		let inclusive_end = reverse === true ? !exclusive_lower : !exclusive_upper;
		let exclusive_start = reverse === true ? exclusive_upper : exclusive_lower;
		let options = {
			transaction,
			start,
			end,
			reverse,
			limit,
			offset,
			inclusiveEnd: inclusive_end,
			exclusiveStart: exclusive_start,
		};
		if (hash_attribute === attribute) {
			options.values = false;
			return attr_dbi.getRange(options).map((value) => ({ value }));
		} else return attr_dbi.getRange(options);
	});
}

/**
 * @param {lmdb.Transaction|lmdb.RootDatabase} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Function} callback
 */
function setupTransaction(transactionOrEnv, hash_attribute, attribute, callback) {
	let env = transactionOrEnv.database || transactionOrEnv;
	// make sure all DBIs have been opened prior to starting any new persistent read transaction
	let attr_dbi = environment_utility.openDBI(env, attribute);
	if (attr_dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	} else if (hash_attribute) {
		environment_utility.openDBI(env, hash_attribute);
	}
	let transaction;
	if (transactionOrEnv.database) transaction = transactionOrEnv;
	else {
		transaction = transactionOrEnv.useReadTransaction();
		transaction.database = transactionOrEnv;
	}
	// do the main query after the dbi opening has been committed
	let results = callback(transaction, attr_dbi, env, hash_attribute);
	results.transaction = transaction;
	if (!transactionOrEnv.database) {
		results.onDone = () => {
			transaction.done();
		};
	}
	return results;
}

function getOverflowCheck(env, transaction, hash_attribute, attribute) {
	let primary_dbi;

	return function (key, value) {
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
			let record = primary_dbi.get(value, { transaction, lazy: true });
			key = record[attribute];
		}
		return key;
	};
}

/**
 * iterates the entire  hash_attribute dbi and returns all objects back
 * @param {lmdb.Transaction} transaction - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @returns {Array.<Object>} - object array of fetched records
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 */
function searchAll(
	transactionOrEnv,
	hash_attribute,
	fetch_attributes,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(transactionOrEnv);
	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}
	return setupTransaction(transactionOrEnv, hash_attribute, hash_attribute, (transaction, dbi, env) => {
		validateFetchAttributes(fetch_attributes);
		fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);
		return dbi
			.getRange({
				transaction,
				start: reverse ? undefined : false,
				end: !reverse ? undefined : false,
				limit: limit,
				offset: offset,
				reverse: reverse,
			})
			.map((entry) => {
				return parseRow(entry.value, fetch_attributes);
			});
	});
}

/**
* iterates the entire  hash_attribute dbi and returns all objects back in a map
* @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
* @param {String} hash_attribute - name of the hash_attribute for this environment
* @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
* @returns {{String|Number, Object}} - object array of fetched records

*/
function searchAllToMap(
	transactionOrEnv,
	hash_attribute,
	fetch_attributes,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(transactionOrEnv);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);
	fetch_attributes = setGetWholeRowAttributes(transactionOrEnv.database || transactionOrEnv, fetch_attributes);
	let map = new Map();
	for (let { key, value } of iterateFullIndex(
		transactionOrEnv,
		hash_attribute,
		hash_attribute,
		reverse,
		limit,
		offset
	)) {
		map.set(key, cursor_functions.parseRow(value, fetch_attributes));
	}
	return map;
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
function iterateDBI(transactionOrEnv, attribute, reverse = false, limit = undefined, offset = undefined) {
	common.validateEnv(transactionOrEnv);

	if (attribute === undefined) {
		throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
	}
	let results = Object.create(null);
	let iterator = iterateFullIndex(transactionOrEnv, undefined, attribute, reverse, limit, offset);
	let transaction = iterator.transaction;
	const overflow_check = getOverflowCheck(transaction.database, transaction, undefined, attribute);
	for (let { key, value } of iterator) {
		let full_key = overflow_check(key, value);
		if (results[full_key] === undefined) {
			results[full_key] = [];
		}
		results[full_key].push(value);
	}
	return results;
}

/**
 * counts all records in an environment based on the count from stating the hash_attribute  dbi
 * @param {lmdb.RootDatabase} env - Transaction used to interact with all data in an environment
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
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function equals(
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, dbi, env, hash_attribute) => {
		search_value = common.convertKeyValueToWrite(search_value);
		if (hash_attribute === attribute) {
			let value = dbi.get(search_value, { transaction, lazy: true });
			return value === undefined ? [] : [{ key: search_value, value: search_value }];
		} else {
			return dbi
				.getValues(search_value, {
					transaction,
					reverse,
					limit,
					offset,
				})
				.map((value) => ({ key: search_value, value }));
		}
	});
}

/**
 * Counts the number of entries for a key of a named dbi, returning the count
 * @param {lmdb.RootDatabase} env - Transaction used to interact with all data in an environment
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
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {lmdb.ArrayLikeIterable<unknown>} - ids matching the search
 */
function startsWith(
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);
	return setupTransaction(transactionOrEnv, null, attribute, (transaction, dbi) => {
		//if the search is numeric we need to scan the entire index, if string we can just do a range
		search_value = common.convertKeyValueToWrite(search_value);
		let string_search = true;
		if (typeof search_value === 'number') {
			string_search = false;
		}
		let iterator;
		//if we are reversing we need to get the key after the one we want to search on so we can start there and iterate to the front
		if (reverse === true) {
			let next_key;
			//iterate based on the search_value until the key no longer starts with the search_value, this is the key we need to start with in the search
			for (let key of dbi.getKeys({ transaction, start: search_value })) {
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

			iterator = dbi.getRange({ transaction, start: next_key, end: undefined, reverse, limit, offset }).map((entry) => {
				let { key } = entry;
				if (key === next_key) {
					return;
				}

				if (key.toString().startsWith(search_value)) {
					return entry;
				} else if (string_search === true) {
					return iterator.DONE;
				}
			});
			return iterator.filter((entry) => entry);
		} else {
			iterator = dbi.getRange({ transaction, start: search_value, reverse, limit, offset }).map((entry) => {
				if (entry.key.toString().startsWith(search_value)) {
					return entry;
				} else if (string_search === true) {
					return iterator.DONE;
				}
			});
			return string_search ? iterator : iterator.filter((entry) => entry); // filter out non-matching if we are not
			// a string and have to do a full scan
		}
	});
}

/**
 * performs an endsWith search on the key of a named dbi, returns a list of ids where their keys end with search_value
 * @param {lmdb.Transaction} transaction - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param search_value - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function endsWith(
	transaction,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	return contains(transaction, hash_attribute, attribute, search_value, reverse, limit, offset, true);
}

/**
 * performs a contains search on the key of a named dbi, returns a list of ids where their keys contain the search_value
 * @param {lmdb.Transaction|lmdb.RootDatabase} transactionOrEnv - Transaction used to interact with all data in an
 * environment
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
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined,
	ends_with = false
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);
	return setupTransaction(transactionOrEnv, null, attribute, (transaction, attr_dbi, env, hash_attribute) => {
		const overflow_check = getOverflowCheck(env, transaction, hash_attribute, attribute);
		offset = Number.isInteger(offset) ? offset : 0;
		return attr_dbi
			.getKeys({ transaction, end: reverse ? false : undefined, reverse })
			.flatMap((key) => {
				let found_str = key.toString();
				if (found_str.endsWith(OVERFLOW_MARKER)) {
					// the entire value couldn't be encoded because it was too long, so need to search the attributes from
					// the original record
					return attr_dbi
						.getValues(key, { transaction })
						.map((primary_key) => {
							// this will get the full value from each entire record so we can check it
							let full_key = overflow_check(key, primary_key);
							if (ends_with ? full_key.endsWith(search_value) : full_key.includes(search_value)) {
								return { key: full_key, value: primary_key };
							}
						})
						.filter((v) => v);
				} else if (ends_with ? found_str.endsWith(search_value) : found_str.includes(search_value)) {
					if (attr_dbi[lmdb_terms.DBI_DEFINITION_NAME].is_hash_attribute) return { key, value: key };
					else {
						return attr_dbi.getValues(key, { transaction }).map((primary_key) => {
							return { key, value: primary_key };
						});
					}
				}
				return [];
			})
			.slice(offset, limit === undefined ? undefined : limit + (offset || 0));
	});
}

/** RANGE FUNCTIONS **/

/**
 * performs a greater than search for string / numeric search value
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function greaterThan(
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);

	let type = typeof search_value;
	let upper_value;
	if (type === 'string') upper_value = '\uffff';
	else if (type === 'number') upper_value = Infinity;
	else if (type === 'boolean') upper_value = true;
	return iterateRangeBetween(
		transactionOrEnv,
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
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function greaterThanEqual(
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);

	let type = typeof search_value;
	let upper_value;
	if (type === 'string') upper_value = '\uffff';
	else if (type === 'number') upper_value = Infinity;
	else if (type === 'boolean') upper_value = true;
	return iterateRangeBetween(
		transactionOrEnv,
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
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function lessThan(
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);
	let type = typeof search_value;
	let lower_value;
	if (type === 'string') lower_value = '\x00';
	else if (type === 'number') lower_value = -Infinity;
	else if (type === 'boolean') lower_value = false;
	return iterateRangeBetween(
		transactionOrEnv,
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
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} search_value
 * @param {boolean} reverse - defines the direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function lessThanEqual(
	transactionOrEnv,
	hash_attribute,
	attribute,
	search_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, search_value);
	let type = typeof search_value;
	let lower_value;
	if (type === 'string') lower_value = '\x00';
	else if (type === 'number') lower_value = -Infinity;
	else if (type === 'boolean') lower_value = false;
	return iterateRangeBetween(
		transactionOrEnv,
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
 * @param {lmdb.Transaction} transactionOrEnv
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
	transactionOrEnv,
	hash_attribute,
	attribute,
	start_value,
	end_value,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(transactionOrEnv);

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

	return iterateRangeBetween(
		transactionOrEnv,
		hash_attribute,
		attribute,
		start_value,
		end_value,
		reverse,
		limit,
		offset
	);
}

/**
 * finds a single record based on the id passed
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {String} id - id value to search
 * @returns {{}} - object found
 */
function searchByHash(transactionOrEnv, hash_attribute, fetch_attributes, id) {
	common.validateEnv(transactionOrEnv);
	let env = transactionOrEnv.database || transactionOrEnv;
	let transaction = transactionOrEnv.database ? transactionOrEnv : null;
	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);
	fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);
	if (id === undefined) {
		throw new Error(LMDB_ERRORS.ID_REQUIRED);
	}

	let obj = null;
	let object = env.dbis[hash_attribute].get(id, { transaction, lazy: fetch_attributes.length < 3 });

	if (object) {
		obj = cursor_functions.parseRow(object, fetch_attributes);
	}
	return obj;
}

/**
 * checks if a hash value exists based on the id passed
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {String|Number} id - id value to check exists
 * @returns {boolean} - whether the hash exists (true) or not (false)
 */
function checkHashExists(transactionOrEnv, hash_attribute, id) {
	common.validateEnv(transactionOrEnv);
	let env = transactionOrEnv.database || transactionOrEnv;
	let transaction = transactionOrEnv.database ? transactionOrEnv : null;

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	if (id === undefined) {
		throw new Error(LMDB_ERRORS.ID_REQUIRED);
	}

	let found_key = true;

	let value = env.dbis[hash_attribute].get(id, { transaction, lazy: true });

	if (value === undefined) {
		found_key = false;
	}
	return found_key;
}

/**
 * finds an array of records based on the ids passed
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Map} - Map of records found
 */
function batchSearchByHash(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found = []) {
	initializeBatchSearchByHash(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found);

	return batchHashSearch(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found).map((entry) => entry[1]);
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Map} - Map of records found
 */
function batchSearchByHashToMap(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found = []) {
	initializeBatchSearchByHash(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found);
	let results = new Map();
	for (let [id, record] of batchHashSearch(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found)) {
		results.set(id, record);
	}
	return results;
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Object}
 */
function batchHashSearch(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found = []) {
	return setupTransaction(transactionOrEnv, hash_attribute, hash_attribute, (transaction, dbi, env) => {
		fetch_attributes = setGetWholeRowAttributes(env, fetch_attributes);
		let lazy = fetch_attributes.length < 3;

		return ids
			.map((id) => {
				let object = env.dbis[hash_attribute].get(id, { transaction, lazy });
				if (object) {
					return [id, cursor_functions.parseRow(object, fetch_attributes)];
				} else {
					not_found.push(id);
				}
			})
			.filter((object) => object); // omit not found
	});
}

/**
 * function used to intialize the batchSearchByHash functions
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetch_attributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [not_found] -optional,  meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {TransactionCursor}
 */
function initializeBatchSearchByHash(transactionOrEnv, hash_attribute, fetch_attributes, ids, not_found) {
	common.validateEnv(transactionOrEnv);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetch_attributes);

	if (ids === undefined || ids === null) {
		throw new Error(LMDB_ERRORS.IDS_REQUIRED);
	}
	if (!ids[Symbol.iterator]) {
		throw new Error(LMDB_ERRORS.IDS_MUST_BE_ITERABLE);
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
 * @param {lmdb.RootDatabase} env - The env used to interact with all data in an environment
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
