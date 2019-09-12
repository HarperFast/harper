"use strict";

const heGetDataByValue = require('./heGetDataByValue');

module.exports = heSearchByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   hash_values:Array, // hash values to search for
//   get_attributes:Array // attributes to return with search result
// }

async function heSearchByValue(search_object) {
    try {
        const search_results = heGetDataByValue(search_object);
        return Object.values(search_results);
    } catch(err) {
        throw err;
    }
}