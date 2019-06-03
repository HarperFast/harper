"use strict";

class InsertObject {
    constructor(operation_string, schema_string, table_string, hash_attribute_string, records_array) {
        this.operation = operation_string;
        this.schema = schema_string;
        this.table = table_string;
        this.hash_attribute = hash_attribute_string;
        this.records = records_array;
    }
}

module.exports = {
    InsertObject
};