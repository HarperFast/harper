"use strict";

class InsertObject {
    constructor(operation, schema, table, hash_attribute, records) {
        this.operation = operation;
        this.schema = schema;
        this.table = table;
        this.hash_attribute = hash_attribute;
        this.records = records;
    }
}

module.exports = InsertObject;