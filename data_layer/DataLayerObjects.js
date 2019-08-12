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

class NoSQLSeachObject {
    constructor(schema_string, table_string, search_attribute_string, hash_attribute_string, get_attributes_string_array, search_value_string) {
        this.schema = schema_string;
        this.table = table_string;
        this.search_attribute = search_attribute_string;
        this.hash_attribute = hash_attribute_string;
        this.get_attributes= get_attributes_string_array;
        this.search_value = search_value_string;
    }
}

module.exports = {
    InsertObject,
    NoSQLSeachObject
};