"use strict";

const heGetDataByValue = require('./heGetDataByValue');

module.exports = heSearchByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   search_attribute: String // attribute to search for value on
//   search_value:String, // string value to search for
//   get_attributes:Array // attributes to return with search result
// }

function heSearchByValue(search_object) {
    try {
        const search_results = heGetDataByValue(search_object);
        return Object.values(search_results);
    } catch(err) {
        throw err;
    }
}