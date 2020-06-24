'use strict';

/**
 *
 * @param {string} operation
 * @param {String} schema
 * @param {string} table
 * @param {Array.<Object>} records
 */
class UpdateObject {
    /**
     * @param {string} operation
     * @param {String} schema
     * @param {string} table
     * @param {Array.<Object>} records
     */
    constructor(operation, schema, table, records) {
        this.operation = operation;
        this.schema = schema;
        this.table = table;
        this.records = records;
    }
}

module.exports = UpdateObject;