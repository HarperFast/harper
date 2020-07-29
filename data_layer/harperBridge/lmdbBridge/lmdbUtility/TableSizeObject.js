'use strict';

/**
 * represents the table size entry for a table
 */
class TableSizeObject{
    /**
     * @param {String} schema
     * @param {String} table
     * @param {Number} table_size - data size of the table in bytes
     * @param {Number} record_count - number of entries in the table
     * @param {Number} transaction_log_size - number of entries in the transaction log
     * @param {Number} transaction_log_record_count - data size of the transaction log in bytes
     */
    constructor(schema, table, table_size = 0, record_count = 0, transaction_log_size = 0, transaction_log_record_count = 0) {
        this.schema = schema;
        this.table = table;
        this.table_size = table_size;
        this.record_count = record_count;
        this.transaction_log_size = transaction_log_size;
        this.transaction_log_record_count = transaction_log_record_count;
    }
}

module.exports = TableSizeObject;