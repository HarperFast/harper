'use strict';

import { LMDB_ERRORS_ENUM as LMDB_ERRORS } from '../errors/commonErrors.ts';
// eslint-disable-next-line no-unused-vars
import * as lmdb from 'lmdb';
import * as lmdbTerms from './terms.ts';

const PRIMITIVES = ['number', 'string', 'symbol', 'boolean', 'bigint'];
/**
 * validates the env argument
 * @param {lmdb.Transaction|lmdb.RootDatabase} env - environment object used thigh level to interact with all data in an
 * environment
 */
export function validateEnv(this: any, env) {
	env = env?.primaryStore || env;
	if (!env) {
		throw new Error(LMDB_ERRORS.ENV_REQUIRED);
	}
}

/**
 * converts raw data to it's string version
 * @param rawValue
 * @returns {Number|String|null}
 */
export function stringifyData(this: any, rawValue) {
	if (rawValue === null || rawValue === undefined) {
		return null;
	}

	let value;

	try {
		value = typeof rawValue === 'object' ? JSON.stringify(rawValue) : rawValue.toString();
	} catch {
		value = rawValue.toString();
	}

	return value;
}

/**
 * takes a raw value and converts it to be written to LMDB. lmdb-store accepts primitives ('number', 'string', 'symbol', 'boolean', 'bigint', buffer) and array of primitives as keys.
 * if it is anything else we convert to string
 * @param {*} key - raw value which needs to be converted
 * @returns {*}
 */
export function convertKeyValueToWrite(this: any, key) {
	//if this is a primitive return the value
	if (key instanceof Date) {
		return key.valueOf();
	}
	return key;
}

/**
 * Return all the indexable values from an attribute, ready to be indexed
 */
export function getIndexedValues(this: any, value: any, indexNulls?: any) {
	if (value === null) {
		return indexNulls ? [null] : undefined;
	}
	if (value === undefined) {
		return undefined;
	}
	if (PRIMITIVES.includes(typeof value)) {
		if (value.length > lmdbTerms.MAX_SEARCH_KEY_LENGTH) {
			return [value.slice(0, lmdbTerms.MAX_SEARCH_KEY_LENGTH) + lmdbTerms.OVERFLOW_MARKER];
		}
		return [value];
	}
	if (Array.isArray(value)) {
		const values = [];
		for (let i = 0, l = value.length; i < l; i++) {
			let element = value[i];
			if (PRIMITIVES.includes(typeof element)) {
				if (element.length > lmdbTerms.MAX_SEARCH_KEY_LENGTH) {
					values.push(element.slice(0, lmdbTerms.MAX_SEARCH_KEY_LENGTH) + lmdbTerms.OVERFLOW_MARKER);
				} else {
					values.push(element);
				}
			} else if (element === null && indexNulls) {
				values.push(null);
			} else if (element instanceof Date) {
				values.push(element.getTime());
			}
		}
		return values;
	} else if (value instanceof Date) {
		return [value.getTime()];
	}
	return undefined;
}

let lastTime = 0; // reported time used to ensure monotonic time.
let startTime = 0; // the start time of the (current time relative to performance time counter)
function adjustStartTime(this: any) {
	// calculate the start time
	// TODO: We may actually want to implement a gradual time shift if the clock time really changes substantially
	// and for sub-millisecond updates, may want to average them so we can progressively narrow in on true time
	startTime = Date.now() - performance.now();
}
adjustStartTime();
// we periodically update our start time because clock time can drift (but we still ensure monotonic time)
const TIME_ADJUSTMENT_INTERVAL = 60000;
setInterval(adjustStartTime, TIME_ADJUSTMENT_INTERVAL).unref();
/**
 * A monotonic timestamp that is guaranteed to be higher than the last call to this function.
 * Will use decimal microseconds as necessary to differentiate from previous calls without too much drift.
 */
export function getNextMonotonicTime(this: any) {
	let now = performance.now() + startTime;
	if (now > lastTime) {
		// current time is higher than last time, can safely return it
		lastTime = now;
		return now;
	}
	// otherwise, we MUST return a higher time than last time, so we increase the time and return it.
	// increment by as small of count as possible, to minimize how far we are from clock time
	lastTime += 0.000488;
	return lastTime;
}
