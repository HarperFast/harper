"use strict";

/**
 * This class represents the data that is passed into the delete functions.
 */
class DeleteObject {
    constructor(schema, table, hash_values) {
        this.schema = schema;
        this.table = table;
        this.hash_values = hash_values;
    }
}

module.exports = DeleteObject;