'use strict';

const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const lmdb_terms = require('./terms');
const Buffer = require('buffer').Buffer;
const microtime = require('microtime');

const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdb_terms;
const PRIMITIVES = ['number', 'string', 'symbol', 'boolean', 'bigint'];
/**
 * validates the env argument
 * @param {lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an environment
 */
function validateEnv(env) {
	if (!env) {
		throw new Error(LMDB_ERRORS.ENV_REQUIRED);
	}
	if (env.constructor.name !== 'LMDBStore') {
		throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
	}
}

/**
 * converts raw data to it's string version
 * @param raw_value
 * @returns {Number|String|null}
 */
function stringifyData(raw_value) {
	if (raw_value === null || raw_value === undefined) {
		return null;
	}

	let value;

	try {
		value = typeof raw_value === 'object' ? JSON.stringify(raw_value) : raw_value.toString();
	} catch (e) {
		value = raw_value.toString();
	}

	return value;
}

/**
 * takes a raw value and converts it to be written to LMDB. lmdb-store accepts primitives ('number', 'string', 'symbol', 'boolean', 'bigint', buffer) and array of primitives as keys.
 * if it is anything else we convert to string
 * @param {*} key - raw value which needs to be converted
 * @returns {*}
 */
function convertKeyValueToWrite(key) {
	//if this is a primitive return the value
	if (primitiveCheck(key)) {
		return key;
	}

	if (key instanceof Date) {
		return key.valueOf();
	}

	//if this is an array, iterate the array and evalaute if it's contents are primitives. if they are return the array as is. if not we convert to string
	if (Array.isArray(key)) {
		if (key.length === 0) {
			return JSON.stringify(key);
		}

		for (let x = 0, length = key.length; x < length; x++) {
			let array_entry = key[x];

			if (array_entry === null) {
				continue;
			}

			if (!primitiveCheck(array_entry) || array_entry === undefined) {
				return JSON.stringify(key);
			}
		}
		return key;
	}

	//object cannot be a key, always stringify
	if (typeof key === 'object') {
		return JSON.stringify(key);
	}

	return key;
}

/**
 * checks is a value is a primitive type 'number', 'string', 'symbol', 'boolean', 'bigint', buffer
 * @param value
 * @returns {boolean}
 */
function primitiveCheck(value) {
	return PRIMITIVES.indexOf(typeof value) >= 0 || value instanceof Buffer;
}

/**
 * Return all the indexable values from an attribute, ready to be indexed
 */
function getIndexedValues(value) {
	if (value === null || value === undefined)
		return;
	if (PRIMITIVES.includes(typeof value)) {
		if (value.length > MAX_SEARCH_KEY_LENGTH) {
			return [value.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER];
		}
		return [value];
	}
	let values;
	if (Array.isArray(value)) {
		values = [];
		for (let i = 0, l = value.length; i < l; i++) {
			let element = value[i];
			if (PRIMITIVES.includes(typeof element)) {
				if (element.length > MAX_SEARCH_KEY_LENGTH)
					values.push(element.slice(0, MAX_SEARCH_KEY_LENGTH) + OVERFLOW_MARKER);
				else values.push(element);
			}
		}
	}
	return values;
}

/**
 * takes a key from LMDB and if not of type string returns the key, otherwise it does a nominal check if the string has aspects of an object/array and attempts to JSON parse it
 * @param raw_value
 * @returns {*}
 */
function convertKeyValueFromSearch(raw_value) {
	if (
		typeof raw_value === 'string' &&
		((raw_value.startsWith('{') && raw_value.endsWith('}')) || (raw_value.startsWith('[') && raw_value.endsWith(']')))
	) {
		try {
			raw_value = JSON.parse(raw_value);
		} catch (e) {
			//no-op
		}
	}
	return raw_value;
}

/**
 * Gets the time in sub milliseconds & converts it to a decimal number where the milliseconds from epoch are on the left of decimal & sub-millisecond time is on the right
 * @returns {number}
 */
function getMicroTime() {
	let full_micro = microtime.now().toString();
	let pos = full_micro.length - 3;
	return Number(full_micro.slice(0, pos) + '.' + full_micro.slice(pos));
}

module.exports = {
	validateEnv,
	stringifyData,
	convertKeyValueToWrite,
	convertKeyValueFromSearch,
	getMicroTime,
	getIndexedValues,
};
