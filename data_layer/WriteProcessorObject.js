"use strict";

/**
 * defines the data used to explode json into the HDB data model
 */
class WriteProcessorObject {
    /**
     *
     * @param {string} hdb_path
     * @param {string} operation
     * @param {Array.<Object>} records
     * @param {Object} table_schema
     * @param {Array.<string>} attributes
     * @param {Number} epoch
     * @param {Array.<Object>} existing_rows
     */
    constructor(hdb_path, operation, records, table_schema, attributes, epoch, existing_rows) {
        this.operation =  operation;
        this.records = records;
        this.table_schema = table_schema;
        this.hdb_path =  hdb_path;
        this.attributes =  attributes;
        this.epoch = epoch;
        this.existing_rows = existing_rows;
    }
}

module.exports = WriteProcessorObject;