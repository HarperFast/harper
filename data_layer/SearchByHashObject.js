'use strict';

class SearchByHashObject{
    /**
     * @param {String} schema
     * @param {String} table
     * @param {[]} hash_values
     * @param {Array.<String>} get_attributes
     */
    constructor(schema, table, hash_values, get_attributes) {
        this.schema = schema;
        this.table = table;
        this.hash_values = hash_values;
        this.get_attributes = get_attributes;
    }
}

module.exports = SearchByHashObject;