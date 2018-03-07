'use strict';

/***
 * alaSQLExtension.js
 * purpose of this module is to hold custom functions for alasql
 */

const _ = require('lodash');

module.exports = {
    /***
     * distinct_array takes in an array an dedupes its values using lodash. this works on complex as well as simple datatypes
     * @param array
     * @returns array
     */
    distinct_array: function (array){
        if(Array.isArray(array) && array.length > 1){
            return _.uniqWith(array, _.isEqual)
        } else {
            return array;
        }
    }
};