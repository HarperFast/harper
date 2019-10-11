'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const heliumUtils = require('../../../../utility/helium/heliumUtils');

let hdb_helium;
try {
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = processRows;

/**
 * Builds an array of datastores using passed attributes and a matching multi dimensional
 * array of row data. Adds current timestamp to created & updated columns.
 * @param insert_obj
 * @param attributes
 * @param schema_table
 * @param hashes
 * @returns {{datastores: *, processed_rows: *}}
 */
function processRows(insert_obj, attributes, schema_table, hashes) {
    let {schema, table, records} = insert_obj;
    let processed_rows = [];
    let hash_attribute = schema_table.hash_attribute;
    let hash_datastore = heGenerateDataStoreName(schema, table, hash_attribute);
    let timestamp = Date.now();
    let datastores = heBuildDataStoreArray(attributes, schema, table);
    let is_system_schema = insert_obj.schema === hdb_terms.SYSTEM_SCHEMA_NAME;
    let existing_hashes;

    // When updating we need to know if the value exists already so we can timestamp it accordingly, for this we
    // need an array of existing attributes.
    if (insert_obj.operation === hdb_terms.OPERATIONS_ENUM.UPDATE) {
        existing_hashes = getExistingHashes(hashes, hash_datastore);
    }

    // Iterates through array of record objects and validates their hash
    for (let x = 0; x < records.length; x++) {
        let row_records = [];
        validateHash(records[x], hash_attribute);

        // Builds a single row array with each record object. Matches each value to its attribute. If it doesn't contain any data
        // at attribute location a null will be inserted into row array.
        for (let y = 0; y < attributes.length; y++) {
            if (records[x].hasOwnProperty(attributes[y])) {
                const attr_val = attrValueConverter(records[x][attributes[y]]);
                row_records.push(attr_val);
            } else {
                row_records.push(null);
            }
        }
        if (!is_system_schema) {
            // If inserting pushes two identical timestamps to end of row array. These correspond created time & updated time attributes.
            // On updated created time is skipped
            if (insert_obj.operation === hdb_terms.OPERATIONS_ENUM.INSERT) {
                row_records.push(timestamp, timestamp);
            } else {
                // Because update will insert record if it doesn't exist, we need to know if record we are updating exists. If it doesn't
                // Exist the record needs a timestamp in the created time column. If it does exist we only add value to updated column.
                if (existing_hashes.includes(hdb_utils.autoCast(records[x][hash_attribute]))) {
                    row_records.push(null, timestamp);
                } else {
                    row_records.push(timestamp, timestamp);
                }
            }
        }

        // Pushes (nests) completed row inside array of all rows returned by function.
        processed_rows.push([records[x][hash_attribute],row_records]);
    }

    if (!is_system_schema) {
        // Pushes created time and updated time attributes to datastores array
        datastores.push(`${schema}/${table}/${hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME}`);
        datastores.push(`${schema}/${table}/${hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME}`);
    }

    return {
        datastores,
        processed_rows
    };
}

/**
 * Builds single-dimensional array of existing hashes in Helium at a given datastore.
 * @param hashes
 * @param hash_datastore
 * @returns {[]}
 */
function getExistingHashes(hashes, hash_datastore) {
    let existing_hashes = [];
    try {
        let search_result = hdb_helium.searchByKeys(hashes, [hash_datastore]);
        for (let i = 0; i < search_result.length; i++) {
            existing_hashes.push(hdb_utils.autoCast(search_result[i][0]));
        }

        return existing_hashes;
    } catch(err) {
        // In the case that update is called and the datastores have't been created yet, return an empty array
        if (err.message.includes('errno: -118')) {
            return existing_hashes;
        }

        log.error(`Process rows error searching for keys: ${err}`);
        throw err;
    }
}

/**
 * Validates hash value exists and under max char size.
 * @param record
 * @param hash_attribute
 */
function validateHash(record, hash_attribute) {
    if (!record.hasOwnProperty(hash_attribute)) {
        log.error(record);
        throw new Error('transaction aborted due to record(s) with no hash value, check log for more info');
    }

    if (Buffer.byteLength(String(record[hash_attribute])) > hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE) {
        log.error(record);
        throw new Error(`transaction aborted due to record(s) with a hash value that exceeds ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes, check log for more info`);
    }

    //TODO: Do we need to check this?  Discussing w/ David in CORE-632
    if (hdb_terms.FORWARD_SLASH_REGEX.test(record[hash_attribute])) {
        log.error(record);
        throw new Error('transaction aborted due to record(s) with a hash value that contains a forward slash, check log for more info');
    }
}

/**
 * Builds a datastore array using the HDB Helium naming convention
 * [<schema>/<table>/<attribute>]
 * @param attributes
 * @param schema
 * @param table
 * @returns {[]}
 */
function heBuildDataStoreArray(attributes, schema, table) {
    let datastores = [];

    for (let i = 0; i < attributes.length; i++) {
        validateAttribute(attributes[i]);
        datastores.push(heGenerateDataStoreName(schema, table, attributes[i]));
    }

    return datastores;
}

/**
 * Validates that attribute is under max size and is not null, undefined or empty.
 * @param attribute
 */
function validateAttribute(attribute) {
    //TODO: review if we need to check attr name length.  Either way, we need to create different
    // ENUMS for fs and helium so that there is no confusion here.  Will discuss in CORE-632
    if (Buffer.byteLength(String(attribute)) > hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE) {
        throw new Error(`transaction aborted due to attribute name ${attribute} being too long. Attribute names cannot be longer than ${hdb_terms.INSERT_MODULE_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    }

    if (hdb_utils.isEmptyOrZeroLength(attribute) || hdb_utils.isEmpty(attribute.trim())) {
        throw new Error('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    }
}

function attrValueConverter(raw_value) {
    let value;
    try {
        value = typeof raw_value === 'object' ? JSON.stringify(raw_value) : raw_value;
    } catch(e){
        log.error(e);
        value = raw_value;
    }
    return value;
}