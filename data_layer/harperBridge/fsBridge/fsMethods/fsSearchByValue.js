"use strict";

const fsGetDataByValue = require('./fsGetDataByValue');

module.exports = fsSearchByValue;

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   search_attribute: String // attribute to search for value on
//   search_value:String, // string value to search for
//   get_attributes:Array // attributes to return with search result
// }

async function fsSearchByValue(search_object) {
    try {
        const search_results = await fsGetDataByValue(search_object);
        return Object.values(search_results);
    } catch(err) {
        throw err;
    }
}