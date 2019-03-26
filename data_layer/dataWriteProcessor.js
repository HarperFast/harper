"use strict";

const h_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const INSERT_ENUM =  hdb_terms.INSERT_MODULE_ENUM;
const FileObject = require('../utility/fs/FileObject');
const ExplodedObject = require('./ExplodedObject');
const {autoCast} = require('../utility/common_utils');
const uuid = require('uuid/v4');
const file_exists = require('../utility/fs/fileExists');

module.exports = processData;

/**
 * does row and attribute level validation. verifies record does not exist for inserts and does exist for updates.  explodes rows for writing to disk
 * @param {WriteProcessorObject} process_wrapper
 * @returns {Promise<ExplodedObject>}
 */
async function processData(process_wrapper) {
    let {hdb_path, operation, records, table_schema, attributes, epoch, existing_rows} = process_wrapper;

    let hash_attribute = table_schema.hash_attribute;
    let no_hash = false;
    let long_hash = false;
    let long_attribute = false;
    let bad_hash_value = false;
    let blank_attribute = false;
    let hashes = [];
    let folders = {};
    let skipped = [];
    let raw_data = [];
    let base_path = hdb_path + '/' + table_schema.schema + '/' + table_schema.name + '/';
    let hash_path = `${base_path}__hdb_hash/${hash_attribute}/`;
    let unlinks = [];
    for (let x = 0; x < records.length; x++) {
        let record = records[x];

        if (h_utils.isEmpty(record[hash_attribute])) {
            if (operation === 'update') {
                no_hash = true;
                break;
            } else {
                record[hash_attribute] = uuid();
            }
        } else if (hdb_terms.FORWARD_SLASH_REGEX.test(record[hash_attribute])) {
            bad_hash_value = true;
            break;
        } else if (Buffer.byteLength(String(record[hash_attribute])) > INSERT_ENUM.MAX_CHARACTER_SIZE) {
            long_hash = true;
            break;
        }

        let hash_value = record[hash_attribute];

        if (record.skip) {
            skipped.push(autoCast(hash_value));
            continue;
        }

        //here we check to see is this record already exists: inserts, we do not want them to exist.  updates we do
        let exists;
        if (operation === 'insert') {
            exists = await file_exists(`${hash_path}${hash_value}.hdb`);
        } else {
            exists = existing_rows[hash_value];
        }


        if ((operation === 'insert' && exists) || (operation === 'update' && !exists)) {
            skipped.push(autoCast(hash_value));
            continue;
        }

        let record_keys = [];
        if (operation === 'update') {
            let {unlink_paths, write_keys} = compareUpdatesToExistingRecords(record, exists, table_schema, hdb_path);
            unlink_paths.forEach((ulink) => {
                unlinks.push(ulink);
            });
            record_keys = write_keys;
        } else {
            record_keys = Object.keys(record);
        }


        //compare update to existing row
        if (h_utils.isEmptyOrZeroLength(record_keys)) {
            skipped.push(autoCast(hash_value));
            continue;
        }

        hashes.push(hash_value);
        for (let k = 0; k < record_keys.length; k++) {
            let property = record_keys[k];
            //don't allow empty attribute names
            if (h_utils.isEmpty(property) || h_utils.isEmpty(property.trim())) {
                blank_attribute = true;
                break;
            }
            //evaluate that there are no attributes who have a name longer than 250 characters
            if (Buffer.byteLength(String(property)) > INSERT_ENUM.MAX_CHARACTER_SIZE) {
                long_attribute = true;
                break;
            }

            //explode the row
            if (property === 'skip' || property === INSERT_ENUM.HDB_AUTH_HEADER || property === INSERT_ENUM.HDB_USER_DATA_KEY) {
                continue;
            }

            let {value, value_path} = h_utils.valueConverter(record[property]);
            let attribute_file_name = hash_value + '.hdb';
            let attribute_path = base_path + property + '/' + value_path;

            let file_obj = new FileObject(`${base_path}__hdb_hash/${property}/${attribute_file_name}`, value);
            raw_data.push(file_obj);
            folders[attribute_path] = 1;
            if (property === hash_attribute) {
                raw_data.push(
                    new FileObject(`${attribute_path}/${epoch}.hdb`, JSON.stringify(record, filterHDBValues))
                );
            } else {
                file_obj.link_path = `${attribute_path}/${attribute_file_name}`;
            }
        }

        if (long_attribute || blank_attribute) {
            break;
        }

    }

    attributes.forEach((attribute) => {
        folders[`${base_path}__hdb_hash/${attribute}`] = 1;
    });

    if (no_hash) {
        throw new Error('transaction aborted due to record(s) with no hash value.');
    }

    if (long_hash) {
        throw new Error(`transaction aborted due to record(s) with a hash value that exceeds ${INSERT_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    }

    if (bad_hash_value) {
        throw new Error('transaction aborted due to record(s) with a hash value that contains a forward slash.');
    }

    if (long_attribute) {
        throw new Error(`transaction aborted due to record(s) with an attribute that exceeds ${INSERT_ENUM.MAX_CHARACTER_SIZE} bytes.`);
    }

    if (blank_attribute) {
        throw new Error('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    }

    let exploded_wrapper = new ExplodedObject(hashes, skipped, Object.keys(folders), raw_data, unlinks);
    process_wrapper = null;
    return exploded_wrapper;
};

/**
 * This function is used to remove HDB internal values (such as HDB_INTERNAL_PATH) from the record when it
 * is stringified.
 * @param key - the key of the record
 * @param value - the value of the record
 * @returns {*}
 */
function filterHDBValues(key, value) {
    if(key === INSERT_ENUM.HDB_PATH_KEY || key === INSERT_ENUM.HDB_AUTH_HEADER || key === INSERT_ENUM.HDB_USER_DATA_KEY) {
        return undefined;
    }
    else {
        return value;
    }
}

/**
 * checks what records and attributes need to be updated
 * @param update_record
 * @param existing_record
 * @param table_schema
 * @param hdb_path
 * @returns {{unlink_paths: Array, write_keys: Array}}
 */
function compareUpdatesToExistingRecords(update_record, existing_record, table_schema, hdb_path) {
    let base_path = hdb_path + '/' + table_schema.schema + '/' + table_schema.name + '/';

    let hash_attribute = table_schema.hash_attribute;
    let unlink_paths = [];
    let attributes = [];
    try {
        let hash_value = existing_record[hash_attribute];

        for (let attr in update_record) {
            if (attr === 'skip' || attr === INSERT_ENUM.HDB_AUTH_HEADER || attr === INSERT_ENUM.HDB_USER_DATA_KEY) {
                continue;
            }

            //we don't autocast the update record because it has already be cast
            if (autoCast(existing_record[attr]) !== update_record[attr]) {
                attributes.push(attr);
                let {value_path} = h_utils.valueConverter(existing_record[attr]);

                if (!h_utils.isEmpty(existing_record[attr]) && !h_utils.isEmpty(value_path)) {
                    unlink_paths.push(`${base_path}${attr}/${value_path}/${hash_value}.hdb`);
                }

                if (h_utils.isEmpty(update_record[attr])) {
                    unlink_paths.push(`${base_path}__hdb_hash/${attr}/${hash_value}.hdb`);
                }
            }
        }

        return {unlink_paths: unlink_paths, write_keys: attributes};
    } catch(e) {
        throw (e);
    }
}