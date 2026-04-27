'use strict';;
import _ from 'lodash';
import mathjs from 'mathjs';
import jsonata from 'jsonata';
import * as hdbUtils from '../../common_utils.js';

/***
 * handles the 3 pass loop for aggregates and executes the final calc with the passed in aggregator function
 * alasql's stages work like the following:
 * stage 1 is the very first record and requires you to return what is the array variable from then on
 * stage 2 occurs for every following row
 * stage 3 is where the processing occurs and returns the final result
 * @param calculationFunction - function to execute to perform the calculation
 * @param value - value per row
 * @param array - the aggregate list of values
 * @param stage - defines the stage in processing see description above
 * @returns {*}
 */
function aggregateFunction(calculationFunction, value, array, stage) {
	if (stage === 1) {
		if (value === null || value === undefined) {
			return [];
		}

		return [value];
	} else if (stage === 2) {
		if (value !== null && value !== undefined) {
			array.push(value);
		}
		return array;
	} else {
		if (array !== null && array !== undefined && array.length > 0) {
			return calculationFunction(array);
		}

		return null;
	}
}

/***
 * distinctArray takes in an array an dedupes its values using lodash. this works on complex as well as simple datatypes
 * @param array
 * @returns array
 */
export const distinct_array = (array) => {
	if (Array.isArray(array) && array.length > 1) {
		return _.uniqWith(array, _.isEqual);
	}

	return array;
};

/***
 * median absolute deviation aggregate function based on http://mathjs.org/docs/reference/functions/mad.html
 */
export const mad = (value, array, stage) => aggregateFunction(mathjs.mad, value, array, stage);
/***
 * mean aggregate function based on http://mathjs.org/docs/reference/functions/mean.html
 */
export const mean = (value, array, stage) => aggregateFunction(mathjs.mean, value, array, stage);
/***
 * computes the mode of values on http://mathjs.org/docs/reference/functions/mode.html
 */
export const mode = (value, array, stage) => aggregateFunction(mathjs.mode, value, array, stage);
/***
 * compute the product based on http://mathjs.org/docs/reference/functions/prod.html
 */
export const prod = (value, array, stage) => aggregateFunction(mathjs.prod, value, array, stage);
/***
 * compute the median based on http://mathjs.org/docs/reference/functions/median.html
 */
export const median = (value, array, stage) => aggregateFunction(mathjs.median, value, array, stage);

/**
 * wrapper function that implements the JSONata library, which performs searches, transforms, etc... on JSON
 * @param {String} jsonataExpression - the JSONata expression to execute
 * @param {any} data - data which will be evaluated
 * @returns {any}
 */
export function searchJSON(jsonataExpression, data) {
	if (typeof jsonataExpression !== 'string' || jsonataExpression.length === 0) {
		throw new Error('search json expression must be a non-empty string');
	}

	let alias = '__' + jsonataExpression + '__';

	if ((hdbUtils as any).isEmpty(this.__ala__.res)) {
		this.__ala__.res = {};
	}

	if ((hdbUtils as any).isEmpty(this.__ala__.res[alias])) {
		let expression = jsonata(jsonataExpression);
		this.__ala__.res[alias] = expression;
	}
	return this.__ala__.res[alias].evaluate(data);
}

export default {
    distinct_array,
    mad,
    mean,
    mode,
    prod,
    median,
    searchJSON
};
