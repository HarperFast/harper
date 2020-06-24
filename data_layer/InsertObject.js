"use strict";

/**
 * This class represents the data that is passed into the Insert functions.
 * @param {String} operation
 * @param {String} schema
 * @param {String} table
 * @param {String} hash_attribute
 * @param {Array.<Object>} records
 */
class InsertObject {
    /**
     * @param {String} operation
     * @param {String} schema
     * @param {String} table
     * @param {String} hash_attribute
     * @param {Array.<Object>} records
     */
    constructor(operation, schema, table, hash_attribute, records) {
        this.operation = operation;
        this.schema = schema;
        this.table = table;
        this.hash_attribute = hash_attribute;
        this.records = records;
    }
}

module.exports = InsertObject;