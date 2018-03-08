'use strict';

/***
 * alaSQLExtension.js
 * purpose of this module is to hold custom functions for alasql
 */

const _ = require('lodash'),
    mathjs = require('mathjs');

module.exports = {
    /***
     * distinct_array takes in an array an dedupes its values using lodash. this works on complex as well as simple datatypes
     * @param array
     * @returns array
     */
    distinct_array:  (array)=>{
        if(Array.isArray(array) && array.length > 1){
            return _.uniqWith(array, _.isEqual)
        } else {
            return array;
        }
    },
    /***
     * median absolute deviation aggregate function based on http://mathjs.org/docs/reference/functions/mad.html
     */
    mad:aggregateFunction.bind(null, mathjs.mad),
    /***
     * mean aggregate function based on http://mathjs.org/docs/reference/functions/mean.html
     */
    mean:aggregateFunction.bind(null, mathjs.mean),
    /***
     * computes the mode of values on http://mathjs.org/docs/reference/functions/mode.html
     */
    mode:aggregateFunction.bind(null, mathjs.mode),
    /***
     * compute the product based on http://mathjs.org/docs/reference/functions/prod.html
     */
    prod:aggregateFunction.bind(null, mathjs.prod),
    /***
     * compute the median based on http://mathjs.org/docs/reference/functions/median.html
     */
    median:aggregateFunction.bind(null, mathjs.median)
};

/***
 * handles the 3 pass loop for aggregates and executes the final calc with the passed in aggregator function
 * alasql's stages work like the following:
 * stage 1 is the very first record and requires you to return what is the array variable from then on
 * stage 2 occurs for every following row
 * stage 3 is where the processing occurs and returns the final result
 * @param calculation_function - function to execute to perform the calculation
 * @param value - value per row
 * @param array - the aggregate list of values
 * @param stage - defines the stage in processing see description above
 * @returns {*}
 */
function aggregateFunction(calculation_function, value, array, stage){
    if(stage === 1){
        if(value === null || value === undefined){
            return [];
        }

        return [value];
    } else if(stage === 2){
        if(value !== null && value !== undefined){
            array.push(value);
        }
        return array;
    } else {
        if(array.length > 0){
            return calculation_function(array);
        }

        return 0;

    }
}