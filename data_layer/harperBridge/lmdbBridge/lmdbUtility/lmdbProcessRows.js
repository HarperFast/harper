'use strict';

module.exports = processRows;

/**
 * Builds an array of dbis using passed attributes and a matching multi dimensional
 * array of row data. Adds current timestamp to created & updated columns.
 * @param insert_obj
 * @param attributes
 * @param schema_table
 * @param hashes
 * @returns {{datastores: *, processed_rows: *}}
 */
function processRows(insert_obj, attributes, schema_table, hashes) {

}