"use strict";

/**
 * defines the data used to from explode json into the HDB data model
 * @param {string} operation - insert or update
 * @param {Array.<object>} records -  to explode and write
 * @param {string} schema - schema name
 * @param {string} table - table name
 * @param {string} hash_attribute - primary key of table
 * @param {string} hdb_path - the base path to the schema folder on the file system
 * @param {Array.<string>} attributes - list of attributes for this set of records
 */
class ExploderObject {
    constructor(operation, records, schema, table, hash_attribute, hdb_path, attributes) {
        this.operation =  operation;
        this.records = records;
        this.schema = schema;
        this.table =  table;
        this.hash_attribute =  hash_attribute;
        this.hdb_path =  hdb_path;
        this.attributes =  attributes;
    }
}

module.exports = ExploderObject;