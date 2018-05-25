"use strict";

class DeleteObject {
    constructor(schema, table, hash_values) {
        this.schema = schema;
        this.table = table;
        this.hash_values = hash_values;
    }
}

module.exports = DeleteObject;