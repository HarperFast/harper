"use strict";
const OPERATIONS_ENUM = require('../utility/hdbTerms').OPERATIONS_ENUM;
/**
 * This class represents the data that is passed into the Insert functions.
 * @param {String} schema
 * @param {String} table
 * @param {String} hash_attribute
 * @param {Array.<Object>} records
 */
class InsertObject {
    /**
     * @param {String} schema
     * @param {String} table
     * @param {String} hash_attribute
     * @param {Array.<Object>} records
     */
    constructor(schema, table, hash_attribute, records) {
        this.operation = OPERATIONS_ENUM.INSERT;
        this.schema = schema;
        this.table = table;
        this.hash_attribute = hash_attribute;
        this.records = records;
    }
}

module.exports = InsertObject;