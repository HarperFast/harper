'use strict';
const OPERATIONS_ENUM = require('../utility/hdbTerms').OPERATIONS_ENUM;

/**
 * opject representing an update operation
 * @param {String} schema
 * @param {string} table
 * @param {Array.<Object>} records
 */
class UpdateObject {
    /**
     * @param {String} schema
     * @param {string} table
     * @param {Array.<Object>} records
     */
    constructor(schema, table, records) {
        this.operation = OPERATIONS_ENUM.UPDATE;
        this.schema = schema;
        this.table = table;
        this.records = records;
    }
}

module.exports = UpdateObject;