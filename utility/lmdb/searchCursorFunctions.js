'use strict';

const hdbTerms = require('../hdbTerms.ts');
const common = require('./commonUtility.js');

function parseRow(originalObject, attributes) {
	let returnObject = Object.create(null);

	if (attributes.length === 1 && hdbTerms.SEARCH_WILDCARDS.indexOf(attributes[0]) >= 0) {
		Object.assign(returnObject, originalObject);
	} else {
		for (let x = 0; x < attributes.length; x++) {
			let attribute = attributes[x];
			let attributeValue = originalObject[attribute];
			returnObject[attribute] = attributeValue === undefined ? null : attributeValue;
		}
	}

	return returnObject;
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
	let newObject = Object.create(null);
	newObject[attribute] = key;
	let hashValue = undefined;

	if (hash_attribute === attribute) {
		hashValue = key;
	} else {
		hashValue = value;
		if (hash_attribute !== undefined) {
			newObject[hash_attribute] = hashValue;
		}
	}
	results[0].push(hashValue);
	results[1].push(newObject);
}

/**
 * The internal iterator function for endsWith
 * @param {String} compareValue
 * @param {*} found
 * @param {*} value
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function endsWith(compareValue, found, value, results, hash_attribute, attribute) {
	let foundStr = found.toString();
	if (foundStr.endsWith(compareValue)) {
		pushResults(found, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for contains
 * @param {*} compareValue
 * @param {*} key
 * @param {*} value
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function contains(compareValue, key, value, results, hash_attribute, attribute) {
	let foundStr = key.toString();
	if (foundStr.includes(compareValue)) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for greater than, used for string keyed dbis and a string compareValue
 * @param {*} compareValue
 * @param {*} key
 * @param {*} value
 * @param {Object} results
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanCompare(compareValue, key, value, results, hash_attribute, attribute) {
	if (key > compareValue) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for greater than equal, used for string keyed dbis and a sring compareValue
 * @param {*} key
 * @param {*} value
 * @param {[[],[]]} results
 * @param {*} compareValue
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function greaterThanEqualCompare(compareValue, key, value, results, hash_attribute, attribute) {
	if (key >= compareValue) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for less than, used for string keyed dbis and a string compareValue
 * @param {*} key
 * @param {*} value
 * @param {Object} results
 * @param {*} compareValue
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanCompare(compareValue, key, value, results, hash_attribute, attribute) {
	if (key < compareValue) {
		pushResults(key, value, results, hash_attribute, attribute);
	}
}

/**
 * The internal iterator function for less than equal, used for string keyed dbis and a string compareValue
 * @param {*} key
 * @param {*} value
 * @param {[[],[]]} results
 * @param {*} compareValue
 * @param {String} hash_attribute
 * @param {String} attribute
 */
function lessThanEqualCompare(compareValue, key, value, results, hash_attribute, attribute) {
	if (key <= compareValue) {
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
