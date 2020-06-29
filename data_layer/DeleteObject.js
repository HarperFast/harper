"use strict";

const OPERATIONS_ENUM = require('../utility/hdbTerms').OPERATIONS_ENUM;

/**
 * This class represents the data that is passed into the delete functions.
 * @param {string} schema
 * @param {string} table
 * @param {[string|number]} hash_values
 */
class DeleteObject {
    /**
     *
     * @param {string} schema
     * @param {string} table
     * @param {[string|number]} hash_values
     */
    constructor(schema, table, hash_values) {
        this.operation = OPERATIONS_ENUM.DELETE;
        this.schema = schema;
        this.table = table;
        this.hash_values = hash_values;
    }
}

module.exports = DeleteObject;