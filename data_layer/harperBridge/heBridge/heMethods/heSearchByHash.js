"use strict";

const heGetDataByHash = require('./heGetDataByHash');

module.exports = heSearchByHash;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   hash_values:Array, // hash values to search for
//   get_attributes:Array // attributes to return with search result
// }

function heSearchByHash(search_object) {
    try {
        const search_results = heGetDataByHash(search_object);
        return Object.values(search_results);
    } catch(err) {
        throw err;
    }
}