'use strict';

class UpdateObject {
    constructor(operation, schema, table, records) {
        this.operation = operation;
        this.schema = schema;
        this.table = table;
        this.records = records;
    }
}

module.exports = UpdateObject;