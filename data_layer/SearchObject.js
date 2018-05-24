"use strict";

class SearchObject {
    constructor(schema, table, search_attribute, search_value, hash_attribute, get_attributes) {
            this.schema = schema;
            this.table = table;
            this.search_attribute = search_attribute;
            this.search_value = search_value;
            this.hash_attribute = hash_attribute;
            this.get_attributes = get_attributes;
    }
}

module.exports = SearchObject;