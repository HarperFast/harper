'use strict';

const environmentUtility = require('./environmentUtility.js');

const log = require('../logging/harper_logger.js');
const common = require('./commonUtility.js');
const lmdbTerms = require('./terms.js');
const LMDB_ERRORS = require('../errors/commonErrors.js').LMDB_ERRORS_ENUM;
const hdbUtils = require('../common_utils.js');
const hdbTerms = require('../hdbTerms.ts');
const cursorFunctions = require('./searchCursorFunctions.js');
const { parseRow } = cursorFunctions;
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdbTerms;
const LAZY_PROPERTY_ACCESS = { lazy: true };

/** UTILITY CURSOR FUNCTIONS **/

/**
 * Creates the basis for a full iteration of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Transaction} transactionOrEnv
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {Function} evalFunction
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
			limit,
			offset,
			reverse,
		});
	});
}

/**
 * Creates the basis for a forward/reverse range search of a dbi with an evaluation function used to determine the logic inside the iteration
 * @param {lmdb.Transaction} transaction
 * @param {String} hash_attribute
 * @param {String} attribute
 * @param {String|Number} searchValue
 * @param {Function} evalFunction
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function iterateRangeNext(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	evalFunction,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, dbi, env, hash_attribute) => {
		const overflowCheck = getOverflowCheck(env, transaction, hash_attribute, attribute);
		let results = [[], []];
		//because reversing only returns 1 entry from a dup sorted key we get all entries for the search value
		let startValue = reverse === true ? undefined : searchValue === undefined ? false : searchValue;
		let endValue = reverse === true ? searchValue : undefined;

		for (let { key, value } of dbi.getRange({
			transaction,
			start: startValue,
			end: endValue,
			reverse,
			limit,
			offset,
		})) {
			evalFunction(searchValue, overflowCheck(key, value), value, results, hash_attribute, attribute);
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
 * @param {Number|String} lowerValue
 * @param {Number|String} upperValue
 * @param {boolean} reverse
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {Iterable}
 */
function iterateRangeBetween(
	transactionOrEnv,
	hash_attribute,
	attribute,
	lowerValue,
	upperValue,
	reverse = false,
	limit = undefined,
	offset = undefined,
	exclusiveLower = false,
	exclusiveUpper = false
) {
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, attrDbi, env, hash_attribute) => {
		let end = reverse === true ? lowerValue : upperValue;
		let start = reverse === true ? upperValue : lowerValue;
		let inclusiveEnd = reverse === true ? !exclusiveLower : !exclusiveUpper;
		let exclusiveStart = reverse === true ? exclusiveUpper : exclusiveLower;
		let options = {
			transaction,
			start,
			end,
			reverse,
			limit,
			offset,
			inclusiveEnd,
			exclusiveStart,
		};
		if (hash_attribute === attribute) {
			options.values = false;
			return attrDbi.getRange(options).map((value) => ({ value }));
		} else return attrDbi.getRange(options);
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
	let attrDbi = environmentUtility.openDBI(env, attribute);
	if (attrDbi[lmdbTerms.DBI_DEFINITION_NAME].is_hash_attribute) {
		hash_attribute = attribute;
	} else if (hash_attribute) {
		environmentUtility.openDBI(env, hash_attribute);
	}
	let transaction;
	if (transactionOrEnv.database) transaction = transactionOrEnv;
	else {
		transaction = transactionOrEnv.useReadTransaction();
		transaction.database = transactionOrEnv;
	}
	// do the main query after the dbi opening has been committed
	let results = callback(transaction, attrDbi, env, hash_attribute);
	results.transaction = transaction;
	if (!transactionOrEnv.database) {
		results.onDone = () => {
			transaction.done();
		};
	}
	return results;
}

function getOverflowCheck(env, transaction, hash_attribute, attribute) {
	let primaryDbi;

	return function (key, value) {
		if (typeof key === 'string' && key.endsWith(OVERFLOW_MARKER)) {
			// the entire value couldn't be encoded because it was too long, so need to search the attribute from
			// the original record.
			// first get the hash/primary dbi
			if (!primaryDbi) {
				// only have to open once per search
				if (hash_attribute) primaryDbi = environmentUtility.openDBI(env, hash_attribute);
				else {
					// not sure how often this gets called without a hash_attribute, as this would be kind of expensive
					// if done frequently
					let dbis = environmentUtility.listDBIs(env);
					for (let i = 0, l = dbis.length; i < l; i++) {
						primaryDbi = environmentUtility.openDBI(env, dbis[i]);
						if (primaryDbi[lmdbTerms.DBI_DEFINITION_NAME].is_hash_attribute) break;
					}
				}
			}
			let record = primaryDbi.get(value, { transaction, lazy: true });
			key = record[attribute];
		}
		return key;
	};
}

/**
 * iterates the entire  hash_attribute dbi and returns all objects back
 * @param {lmdb.Transaction} transaction - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @returns {Array.<Object>} - object array of fetched records
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 */
function searchAll(
	transactionOrEnv,
	hash_attribute,
	fetchAttributes,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(transactionOrEnv);
	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}
	return setupTransaction(transactionOrEnv, hash_attribute, hash_attribute, (transaction, dbi, env) => {
		validateFetchAttributes(fetchAttributes);
		fetchAttributes = setGetWholeRowAttributes(env, fetchAttributes);
		return dbi
			.getRange({
				transaction,
				start: reverse ? undefined : false,
				end: !reverse ? undefined : false,
				limit,
				offset,
				reverse,
			})
			.map((entry) => {
				return parseRow(entry.value, fetchAttributes);
			});
	});
}

/**
* iterates the entire  hash_attribute dbi and returns all objects back in a map
* @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
* @param {String} hash_attribute - name of the hash_attribute for this environment
* @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
* @returns {{String|Number, Object}} - object array of fetched records

*/
function searchAllToMap(
	transactionOrEnv,
	hash_attribute,
	fetchAttributes,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(transactionOrEnv);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetchAttributes);
	fetchAttributes = setGetWholeRowAttributes(transactionOrEnv.database || transactionOrEnv, fetchAttributes);
	let map = new Map();
	for (let { key, value } of iterateFullIndex(
		transactionOrEnv,
		hash_attribute,
		hash_attribute,
		reverse,
		limit,
		offset
	)) {
		map.set(key, cursorFunctions.parseRow(value, fetchAttributes));
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
	const overflowCheck = getOverflowCheck(transaction.database, transaction, undefined, attribute);
	for (let { key, value } of iterator) {
		let fullKey = overflowCheck(key, value);
		if (results[fullKey] === undefined) {
			results[fullKey] = [];
		}
		results[fullKey].push(value);
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

	let stat = environmentUtility.statDBI(env, hash_attribute);
	return stat.entryCount;
}

/**
 * performs an equal search on the key of a named dbi, returns a list of ids where their keys literally match the searchValue
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param searchValue - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function equals(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);
	return setupTransaction(transactionOrEnv, hash_attribute, attribute, (transaction, dbi, env, hash_attribute) => {
		searchValue = common.convertKeyValueToWrite(searchValue);
		if (hash_attribute === attribute) {
			let value = dbi.get(searchValue, { transaction, lazy: true });
			return value === undefined ? [] : [{ key: searchValue, value: searchValue }];
		} else {
			return dbi
				.getValues(searchValue, {
					transaction,
					reverse,
					limit,
					offset,
				})
				.map((value) => ({ key: searchValue, value }));
		}
	});
}

/**
 * Counts the number of entries for a key of a named dbi, returning the count
 * @param {lmdb.RootDatabase} env - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param searchValue - value to search
 */
function count(env, attribute, searchValue) {
	validateComparisonFunctions(env, attribute, searchValue);
	let dbi = environmentUtility.openDBI(env, attribute);
	return dbi.getValuesCount(searchValue);
}

/**
 * performs an startsWith search on the key of a named dbi, returns a list of ids where their keys begin with the searchValue
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param searchValue - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {lmdb.ArrayLikeIterable<unknown>} - ids matching the search
 */
function startsWith(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);
	return setupTransaction(transactionOrEnv, null, attribute, (transaction, dbi) => {
		//if the search is numeric we need to scan the entire index, if string we can just do a range
		searchValue = common.convertKeyValueToWrite(searchValue);
		let stringSearch = true;
		if (typeof searchValue === 'number') {
			stringSearch = false;
		}
		let iterator;
		//if we are reversing we need to get the key after the one we want to search on so we can start there and iterate to the front
		if (reverse === true) {
			let nextKey;
			//iterate based on the searchValue until the key no longer starts with the searchValue, this is the key we need to start with in the search
			for (let key of dbi.getKeys({ transaction, start: searchValue })) {
				if (!key.startsWith(searchValue)) {
					nextKey = key;
					break;
				}
			}

			//with the new search value we iterate
			if (nextKey !== undefined) {
				if (Number.isInteger(offset)) {
					offset++;
				} else {
					limit++;
				}
			}

			iterator = dbi.getRange({ transaction, start: nextKey, end: undefined, reverse, limit, offset }).map((entry) => {
				let { key } = entry;
				if (key === nextKey) {
					return;
				}

				if (key.toString().startsWith(searchValue)) {
					return entry;
				} else if (stringSearch === true) {
					return iterator.DONE;
				}
			});
			return iterator.filter((entry) => entry);
		} else {
			iterator = dbi.getRange({ transaction, start: searchValue, reverse, limit, offset }).map((entry) => {
				if (entry.key.toString().startsWith(searchValue)) {
					return entry;
				} else if (stringSearch === true) {
					return iterator.DONE;
				}
			});
			return stringSearch ? iterator : iterator.filter((entry) => entry); // filter out non-matching if we are not
			// a string and have to do a full scan
		}
	});
}

/**
 * performs an endsWith search on the key of a named dbi, returns a list of ids where their keys end with searchValue
 * @param {lmdb.Transaction} transaction - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param searchValue - value to search
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]} - ids matching the search
 */
function endsWith(
	transaction,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	return contains(transaction, hash_attribute, attribute, searchValue, reverse, limit, offset, true);
}

/**
 * performs a contains search on the key of a named dbi, returns a list of ids where their keys contain the searchValue
 * @param {lmdb.Transaction|lmdb.RootDatabase} transactionOrEnv - Transaction used to interact with all data in an
 * environment
 * @param {String} hash_attribute
 * @param {String} attribute - name of the attribute (dbi) to search
 * @param {String|Number} searchValue - value to search
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
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined,
	ends_with = false
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);
	return setupTransaction(transactionOrEnv, null, attribute, (transaction, attrDbi, env, hash_attribute) => {
		const overflowCheck = getOverflowCheck(env, transaction, hash_attribute, attribute);
		offset = Number.isInteger(offset) ? offset : 0;
		return attrDbi
			.getKeys({ transaction, end: reverse ? false : undefined, reverse })
			.flatMap((key) => {
				let foundStr = key.toString();
				if (foundStr.endsWith(OVERFLOW_MARKER)) {
					// the entire value couldn't be encoded because it was too long, so need to search the attributes from
					// the original record
					return attrDbi
						.getValues(key, { transaction })
						.map((primaryKey) => {
							// this will get the full value from each entire record so we can check it
							let fullKey = overflowCheck(key, primaryKey);
							if (ends_with ? fullKey.endsWith(searchValue) : fullKey.includes(searchValue)) {
								return { key: fullKey, value: primaryKey };
							}
						})
						.filter((v) => v);
				} else if (ends_with ? foundStr.endsWith(searchValue) : foundStr.includes(searchValue)) {
					if (attrDbi[lmdbTerms.DBI_DEFINITION_NAME].is_hash_attribute) return { key, value: key };
					else {
						return attrDbi.getValues(key, { transaction }).map((primaryKey) => {
							return { key, value: primaryKey };
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
 * @param {String|Number} searchValue
 * @param {boolean} reverse - determines direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function greaterThan(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);

	let type = typeof searchValue;
	let upperValue;
	if (type === 'string') upperValue = '\uffff';
	else if (type === 'number') upperValue = Infinity;
	else if (type === 'boolean') upperValue = true;
	return iterateRangeBetween(
		transactionOrEnv,
		hash_attribute,
		attribute,
		searchValue,
		upperValue,
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
 * @param {String|Number} searchValue
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function greaterThanEqual(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);

	let type = typeof searchValue;
	let upperValue;
	if (type === 'string') upperValue = '\uffff';
	else if (type === 'number') upperValue = Infinity;
	else if (type === 'boolean') upperValue = true;
	return iterateRangeBetween(
		transactionOrEnv,
		hash_attribute,
		attribute,
		searchValue,
		upperValue,
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
 * @param {String|Number} searchValue
 * @param {boolean} reverse - determines direction of iterator
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function lessThan(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);
	let type = typeof searchValue;
	let lowerValue;
	if (type === 'string') lowerValue = '\x00';
	else if (type === 'number') lowerValue = -Infinity;
	else if (type === 'boolean') lowerValue = false;
	return iterateRangeBetween(
		transactionOrEnv,
		hash_attribute,
		attribute,
		lowerValue,
		searchValue,
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
 * @param {String|Number} searchValue
 * @param {boolean} reverse - defines the direction to iterate
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {[[],[]]}
 */
function lessThanEqual(
	transactionOrEnv,
	hash_attribute,
	attribute,
	searchValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	validateComparisonFunctions(transactionOrEnv, attribute, searchValue);
	let type = typeof searchValue;
	let lowerValue;
	if (type === 'string') lowerValue = '\x00';
	else if (type === 'number') lowerValue = -Infinity;
	else if (type === 'boolean') lowerValue = false;
	return iterateRangeBetween(
		transactionOrEnv,
		hash_attribute,
		attribute,
		lowerValue,
		searchValue,
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
 * @param {String|Number} startValue
 * @param {String|Number}endValue
 * @param {boolean} reverse - defines if the iterator goes from last to first
 * @param {number} limit - defines the max number of entries to iterate
 * @param {number} offset - defines the entries to skip
 * @returns {*[]}
 */
function between(
	transactionOrEnv,
	hash_attribute,
	attribute,
	startValue,
	endValue,
	reverse = false,
	limit = undefined,
	offset = undefined
) {
	common.validateEnv(transactionOrEnv);

	if (attribute === undefined) {
		throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
	}

	if (startValue === undefined) {
		throw new Error(LMDB_ERRORS.START_VALUE_REQUIRED);
	}

	if (endValue === undefined) {
		throw new Error(LMDB_ERRORS.END_VALUE_REQUIRED);
	}

	startValue = common.convertKeyValueToWrite(startValue);
	endValue = common.convertKeyValueToWrite(endValue);
	if (startValue > endValue) {
		throw new Error(LMDB_ERRORS.END_VALUE_MUST_BE_GREATER_THAN_START_VALUE);
	}

	return iterateRangeBetween(
		transactionOrEnv,
		hash_attribute,
		attribute,
		startValue,
		endValue,
		reverse,
		limit,
		offset
	);
}

/**
 * finds a single record based on the id passed
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @param {String} id - id value to search
 * @returns {{}} - object found
 */
function searchByHash(transactionOrEnv, hash_attribute, fetchAttributes, id) {
	common.validateEnv(transactionOrEnv);
	let env = transactionOrEnv.database || transactionOrEnv;
	let transaction = transactionOrEnv.database ? transactionOrEnv : null;
	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetchAttributes);
	fetchAttributes = setGetWholeRowAttributes(env, fetchAttributes);
	if (id === undefined) {
		throw new Error(LMDB_ERRORS.ID_REQUIRED);
	}

	let obj = null;
	let object = env.dbis[hash_attribute].get(id, { transaction, lazy: fetchAttributes.length < 3 });

	if (object) {
		obj = cursorFunctions.parseRow(object, fetchAttributes);
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

	let foundKey = true;

	let value = env.dbis[hash_attribute].get(id, { transaction, lazy: true });

	if (value === undefined) {
		foundKey = false;
	}
	return foundKey;
}

/**
 * finds an array of records based on the ids passed
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [notFound] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Map} - Map of records found
 */
function batchSearchByHash(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound = []) {
	initializeBatchSearchByHash(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound);

	return batchHashSearch(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound).map((entry) => entry[1]);
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [notFound] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Map} - Map of records found
 */
function batchSearchByHashToMap(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound = []) {
	initializeBatchSearchByHash(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound);
	let results = new Map();
	for (let [id, record] of batchHashSearch(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound)) {
		results.set(id, record);
	}
	return results;
}

/**
 * finds an array of records based on the ids passed and returns a map of the results
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [notFound] - optional, meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {Object}
 */
function batchHashSearch(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound = []) {
	return setupTransaction(transactionOrEnv, hash_attribute, hash_attribute, (transaction, dbi, env) => {
		fetchAttributes = setGetWholeRowAttributes(env, fetchAttributes);
		let lazy = fetchAttributes.length < 3;

		return ids
			.map((id) => {
				let object = env.dbis[hash_attribute].get(id, { transaction, lazy });
				if (object) {
					return [id, cursorFunctions.parseRow(object, fetchAttributes)];
				} else {
					notFound.push(id);
				}
			})
			.filter((object) => object); // omit not found
	});
}

/**
 * function used to intialize the batchSearchByHash functions
 * @param {lmdb.Transaction} transactionOrEnv - Transaction used to interact with all data in an environment
 * @param {String} hash_attribute - name of the hash_attribute for this environment
 * @param {Array.<String>} fetchAttributes - string array of attributes to pull from the object
 * @param {Array.<String>} ids - list of ids to search
 * @param {[]} [notFound] -optional,  meant to be an array passed by reference so that skipped ids can be aggregated.
 * @returns {TransactionCursor}
 */
function initializeBatchSearchByHash(transactionOrEnv, hash_attribute, fetchAttributes, ids, notFound) {
	common.validateEnv(transactionOrEnv);

	if (hash_attribute === undefined) {
		throw new Error(LMDB_ERRORS.HASH_ATTRIBUTE_REQUIRED);
	}

	validateFetchAttributes(fetchAttributes);

	if (ids === undefined || ids === null) {
		throw new Error(LMDB_ERRORS.IDS_REQUIRED);
	}
	if (!ids[Symbol.iterator]) {
		throw new Error(LMDB_ERRORS.IDS_MUST_BE_ITERABLE);
	}
}

/**
 * validates the fetchAttributes argument
 * @param fetchAttributes - string array of attributes to pull from the object
 */
function validateFetchAttributes(fetchAttributes) {
	if (!Array.isArray(fetchAttributes)) {
		if (fetchAttributes === undefined) {
			throw new Error(LMDB_ERRORS.FETCH_ATTRIBUTES_REQUIRED);
		}
		throw new Error(LMDB_ERRORS.FETCH_ATTRIBUTES_MUST_BE_ARRAY);
	}
}

/**
 * common validation function for all of the comparison searches (equals, startsWith, endsWith, contains)
 * @param {lmdb.RootDatabase} env - The env used to interact with all data in an environment
 * @param attribute - name of the attribute (dbi) to search
 * @param searchValue - value to search
 */
function validateComparisonFunctions(env, attribute, searchValue) {
	common.validateEnv(env);
	if (attribute === undefined) {
		throw new Error(LMDB_ERRORS.ATTRIBUTE_REQUIRED);
	}

	if (searchValue === undefined) {
		throw new Error(LMDB_ERRORS.SEARCH_VALUE_REQUIRED);
	}

	if (searchValue?.length > MAX_SEARCH_KEY_LENGTH) {
		throw new Error(LMDB_ERRORS.SEARCH_VALUE_TOO_LARGE);
	}
}

/**
 * determines if the intent is to return the whole row based on fetchAttributes having 1 entry that is wildcard * or %
 * @param env
 * @param fetchAttributes
 * @returns {Array}
 */
function setGetWholeRowAttributes(env, fetchAttributes) {
	if (fetchAttributes.length === 1 && hdbTerms.SEARCH_WILDCARDS.indexOf(fetchAttributes[0]) >= 0) {
		fetchAttributes = environmentUtility.listDBIs(env);
	}

	return fetchAttributes;
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
