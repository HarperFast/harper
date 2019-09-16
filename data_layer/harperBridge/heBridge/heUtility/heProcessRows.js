'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');

module.exports = processRows;

/**
 * Builds an array of datastores using passed attributes and a matching multi dimensional
 * array of row data
 * @param insert_obj
 * @param attributes
 * @param schema_table
 * @returns {{datastores: *, rows: *}}
 */
function processRows(insert_obj, attributes, schema_table) {
    let {schema, table, records} = insert_obj;
    let datastores = [];
    let rows = [];
    let hash_attribute = schema_table.hash_attribute;

    for (let i = 0; i < attributes.length; i++) {
        validateAttribute(attributes[i]);
        datastores.push(`${schema}/${table}/${attributes[i]}`);
    }

    for (let x = 0; x < records.length; x++) {
        let row_records = [];

        validateHash(records[x], hash_attribute);

        for (let y = 0; y < attributes.length; y++) {

            if (records[x].hasOwnProperty(attributes[y])) {
                row_records.push(records[x][attributes[y]]);
            } else {
                row_records.push(null);
            }
        }
        rows.push([records[x][hash_attribute],row_records]);
    }

    return {
        datastores,
        rows
    };
}

/**
 * Validates hash value exists, under max char size and doesn't contain a forward slash.
 * @param record
 * @param hash_attribute
 */
function validateHash(record, hash_attribute) {
    if (!record.hasOwnProperty(hash_attribute)) {
        throw new Error('transaction aborted due to record(s) with no hash value.');
    }

    if (Buffer.byteLength(String(record[hash_attribute])) > hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE) {
        throw new Error(`transaction aborted due to record(s) with a hash value that exceeds ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    }

    if (hdb_terms.FORWARD_SLASH_REGEX.test(record[hash_attribute])) {
        throw new Error('transaction aborted due to record(s) with a hash value that contains a forward slash.');
    }
}

/**
 * Validates that attribute is under max size and is not null, undefined or empty.
 * @param attribute
 */
function validateAttribute(attribute) {
    if (Buffer.byteLength(String(attribute)) > hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE) {
        throw new Error(`transaction aborted due to attribute name ${attribute} being too long. Attribute names cannot be longer than ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    }

    if (hdb_utils.isEmptyOrZeroLength(attribute) || hdb_utils.isEmpty(attribute.trim())) {
        throw new Error('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    }
}
