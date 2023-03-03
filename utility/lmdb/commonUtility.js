'use strict';

const LMDB_ERRORS = require('../errors/commonErrors').LMDB_ERRORS_ENUM;
// eslint-disable-next-line no-unused-vars
const lmdb = require('lmdb');
const lmdb_terms = require('./terms');
const Buffer = require('buffer').Buffer;

const { OVERFLOW_MARKER, MAX_SEARCH_KEY_LENGTH } = lmdb_terms;
const PRIMITIVES = ['number', 'string', 'symbol', 'boolean', 'bigint'];
/**
 * validates the env argument
 * @param {lmdb.Transaction|lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an
 * environment
 */
function validateEnv(env) {
	env = env?.database || env;
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
	if (key instanceof Date) {
		return key.valueOf();
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

let last_time = 0; // reported time used to ensure monotonic time.
let start_time = 0; // the start time of the (current time relative to performance time counter)
function adjustStartTime() {
	// calculate the start time
	// TODO: We may actually want to implement a gradual time shift if the clock time really changes substantially
	// and for sub-millisecond updates, may want to average them so we can progressively narrow in on true time
	start_time = Date.now() - performance.now();
}
adjustStartTime();
// we periodically update our start time because clock time can drift (but we still ensure monotonic time)
const TIME_ADJUSTMENT_INTERVAL = 60000;
setInterval(adjustStartTime, TIME_ADJUSTMENT_INTERVAL).unref();
/**
 * A monotonic timestamp that is guaranteed to be higher than the last call to this function.
 * Will use decimal microseconds as necessary to differentiate from previous calls without too much drift.
 */
function getNextMonotonicTime() {
	let now = performance.now() + start_time;
	if (now > last_time) {
		// current time is higher than last time, can safely return it
		last_time = now;
		return now;
	}
	// otherwise, we MUST return a higher time than last time, so we increase the time and return it.
	// increment by as small of count as possible, to minimize how far we are from clock time
	last_time += 0.000488;
	return last_time;
}
module.exports = {
	validateEnv,
	stringifyData,
	convertKeyValueToWrite,
	getNextMonotonicTime,
	getIndexedValues,
};
