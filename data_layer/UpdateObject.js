'use strict';

let update_object = {
    operation:'update',
    schema: table.databaseid,
    table: table.tableid,
    records:records
};

class UpdateObject {
    constructor(operation, schema, table, records) {
        this.operation = operation;
        this.schema = schema;
        this.table = table;
        this.records = records;
    }
}

module.exports = UpdateObject;