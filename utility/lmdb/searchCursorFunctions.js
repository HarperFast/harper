'use strict';

const hdb_terms = require('../hdbTerms');
const common = require('./commonUtility');

function parseRow(original_object, attributes) {
	let return_object = Object.create(null);

	if (attributes.length === 1 && hdb_terms.SEARCH_WILDCARDS.indexOf(attributes[0]) >= 0) {
		Object.assign(return_object, original_object);
	} else {
		for (let x = 0; x < attributes.length; x++) {
			let attribute = attributes[x];
			let attribute_value = original_object[attribute];
			return_object[attribute] = attribute_value === undefined ? null : attribute_value;
		}
	}

	return return_object;
}

/**
 * The internal iterator function for searchAll
 * @param {[String]} attributes
 * @param {String|Number} key
 * @param {*} value
 * @param {[]} results
 */
function searchAll(attributes, key, value, results) {
	let obj = parseRow(value, attributes);
	results.push(obj);
}

/**
 * The internal iterator function for searchAll
 * @param {[String]} attributes
 * @param {String|Number} key
 * @param {*} value
 * @param {Object} results
 */
function searchAllToMap(attributes, key, value, results) {
	let obj = parseRow(value, attributes);
	results[key] = obj;
}

/**
 * The internal iterator function for iterateDBI
 * @param {*} key
 * @param {*} value
 * @param {[]} results
 */
function iterateDBI(key, value, results) {
	if (results[key] === undefined) {
		results[key] = [];
	}
	results[key].push(value);
}

/**
 * internal function used to add hash value to results, in the scenario of a hash_attribute dbi we just need to add the found key, otherwise we get the value
 * @param {*} key
 * @param {*} value
 * @param {[[],[]]} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function pushResults(key, value, results, hash_attribute, attribute) {
	let new_object = Object.create(null);
	new_object[attribute] = key;
	let hash_value = undefined;

	if (hash_attribute === attribute) {
		hash_value = key;
	} else {
		hash_value = value;
		if (hash_attribute !== undefined) {
			new_object[hash_attribute] = hash_value;
		}
	}
	results[0].push(hash_value);
	results[1].push(new_object);
}

/**
 * The internal iterator function for endsWith
 * @param {String} compare_value
 * @param {*} found
 * @param {*} value
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function endsWith(compare_value, found, value, results, hash_attribute, attribute) {
	let found_str = found.toString();
	if (found_str.endsWith(compare_value)) {
		pushResults(found, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for contains
 * @param {*} compare_value
 * @param {*} key
 * @param {*} value
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function contains(compare_value, key, value, results, hash_attribute, attribute) {
	let found_str = key.toString();
	if (found_str.includes(compare_value)) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a string compare_value
 * @param {*} compare_value
 * @param {*} key
 * @param {*} value
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanCompare(compare_value, key, value, results, hash_attribute, attribute) {
	if (key > compare_value) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a sring compare_value
 * @param {*} key
 * @param {*} value
 * @param {[[],[]]} results
 * @param {*} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanEqualCompare(compare_value, key, value, results, hash_attribute, attribute) {
	if (key >= compare_value) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a string compare_value
 * @param {*} key
 * @param {*} value
 * @param {Object} results
 * @param {*} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanCompare(compare_value, key, value, results, hash_attribute, attribute) {
	if (key < compare_value) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a string compare_value
 * @param {*} key
 * @param {*} value
 * @param {[[],[]]} results
 * @param {*} compare_value
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanEqualCompare(compare_value, key, value, results, hash_attribute, attribute) {
	if (key <= compare_value) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

module.exports = {
	parseRow,
	searchAll,
	searchAllToMap,
	iterateDBI,
	endsWith,
	contains,
	greaterThanCompare,
	greaterThanEqualCompare,
	lessThanCompare,
	lessThanEqualCompare,
	pushResults,
};
