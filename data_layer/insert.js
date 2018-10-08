'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */

const insert_validator = require('../validation/insertValidator.js');
const fs = require('graceful-fs');
const async = require('async');
const path = require('path');
const mkdirp = require('mkdirp');
const h_utils = require('../utility/common_utils');
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const _ = require('lodash');
const truncate = require('truncate-utf8-bytes');
const PropertiesReader = require('properties-reader');
const autocast = require('autocast');
const signalling = require('../utility/signalling');
const hdb_terms = require('../utility/hdbTerms');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');

const unicode_slash = 'U+002F';

const WRITE_RECORDS_ASYNC_EACH_LIMIT = 2500;
const CREATE_FOLDERS_ASYNC_EACH_LIMIT = 2000;

//TODO: This is ugly and string compare is slow.  Refactor this when we bring in promises.
const NO_RESULTS = 'NR';
//This is an internal value that should not be written to the DB.
const HDB_PATH_KEY = 'HDB_INTERNAL_PATH';


module.exports = {
    insert: insertData,
    update:updateData
};
//this must stay after the export to correct a circular dependency issue
const global_schema = require('../utility/globalSchema');

/**
 * This validation is called before an insert or update is performed with the write_object.
 *
 * @param write_object - the object that will be written post-validation
 * @param callback - The caller
 */
function validation(write_object, callback) {
    // Need to validate these outside of the validator as the getTableSchema call will fail with
    // invalid values.
    if(h_utils.isEmpty(write_object)) {
        return callback(`invalid update parameters defined.`);
    }
    if(h_utils.isEmptyOrZeroLength(write_object.schema) ) {
        return callback(`invalid schema specified.`);
    }
    if(h_utils.isEmptyOrZeroLength(write_object.table) ) {
        return callback(`invalid table specified.`);
    }

    global_schema.getTableSchema(write_object.schema, write_object.table, (err, table_schema) => {
        if (err) {
            return callback(err);
        }

        //validate insert_object for required attributes
        let validator = insert_validator(write_object);
        if (validator) {
            callback(validator);
            return;
        }

        if(!Array.isArray(write_object.records)) {
            return callback('records must be an array');
        }

        let hash_attribute = table_schema.hash_attribute;

        //validate that every record has hash_attribute populated
        let no_hash = false;
        let long_hash = false;
        let long_attribute = false;
        let bad_hash_value = false;
        write_object.records.forEach((record)=>{
            if(record[hash_attribute] === null || record[hash_attribute] === undefined){
                no_hash = true;
                return;
            } else if(hdb_terms.FORWARD_SLASH_REGEX.test(record[hash_attribute])) {
                bad_hash_value = true;
                return;
            } else if(Buffer.byteLength(String(record[hash_attribute])) > 250){
                long_hash = true;
                return;
            }

            //evaluate that there are no attributes who have a name longer than 250 characters
            Object.keys(record).forEach((attribute)=>{
                if(Buffer.byteLength(String(attribute)) > 250) {
                    long_attribute = true;
                }
            });
            if(long_attribute) {
                return;
            }
        });

        if (no_hash) {
            return callback(`transaction aborted due to record(s) with no hash value.`);
        }

        if (long_hash) {
            return callback(`transaction aborted due to record(s) with a hash value that exceeds 250 bytes.`);
        }

        if (bad_hash_value) {
            return callback(`transaction aborted due to record(s) with a hash value that contains a forward slash.`);
        }

        if (long_hash) {
            return callback(`transaction aborted due to record(s) with an attribute that exceeds 250 bytes.`);
        }

        callback(null, table_schema);
    });
}

/**
 * Inserts data specified in the insert_object parameter.  Currently if even a single entity in insert_object already exists,
 * the function will return and no other inserts will be performed.
 * @param insert_object
 * @param callback
 */
function insertData(insert_object, callback){
    try {
        if (insert_object.operation !== 'insert') {
            callback('invalid operation, must be insert');
        }
        let inserted_records = [];
        let skipped_records = [];

        async.waterfall([
            validation.bind(null, insert_object),
            (table_schema, caller) => {
                let hash_attribute = table_schema.hash_attribute;
                let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
                insert_object.dup_check = {};

                for (let r in insert_object.records) {
                    let hash_val = insert_object.records[r][hash_attribute];
                    // If duplicate, we don't assign the HDB_INTERNAL_PATH internal attribute so it will be skipped later.
                    if(insert_object.dup_check[hash_val]) {
                        continue;
                    }
                    insert_object.dup_check[hash_val] = {};
                    let record = insert_object.records[r];
                    let path = `${base_path}__hdb_hash/${hash_attribute}/${record[hash_attribute]}.hdb`;
                    //Internal record that is removed if the record exists.  Should not be written to the DB.
                    insert_object.records[r][HDB_PATH_KEY] = path;

                }
                caller(null);
            },
            checkRecordsExist.bind(null, insert_object, skipped_records, inserted_records),
            checkAttributeSchema.bind(null, insert_object),
            processData
        ], (err) => {
            if (err) {
                return callback(err);
            }
            let return_object = {
                message: `inserted ${inserted_records.length} of ${insert_object.records.length} records`,
                inserted_hashes: inserted_records,
                skipped_hashes: skipped_records
            };
            callback(null, return_object);
        });
    } catch(e){
        callback(e);
    }
}

/**
 * Updates the data in the update_object parameter.
 * @param update_object - The data that will be updated in the database
 * @param callback - The caller
 */
function updateData(update_object, callback){
    try {
        if (update_object.operation !== 'update') {
            return callback('invalid operation, must be update');
        }
        let tracker = {
            all_ids:[],
            update_ids:[]
        };
        let hash_attribute;

        async.waterfall([
            validation.bind(null, update_object),
            (table_schema, caller) => {
                let attributes = new Set();
                let hashes = [];
                update_object.records.forEach((record) => {
                    hashes.push(autocast(record[table_schema.hash_attribute]));
                    Object.keys(record).forEach((attribute) => {
                        attributes.add(attribute);
                    });
                });

                tracker.all_ids = hashes;

                let search_obj = {
                    schema: update_object.schema,
                    table: update_object.table,
                    hash_attribute: 'id',
                    hash_values: hashes,
                    get_attributes: Array.from(attributes)
                };

                caller(null, search_obj);
            },
            (search_obj, caller) => {
                // We need to filter out any new attributes from the update statement, as they will not be found in the searchByHash
                // call below and cause a validation error.
                let valid_attributes = search_obj.get_attributes.filter(function (item) {
                    let attributes = global.hdb_schema[search_obj.schema][search_obj.table].attributes;
                    if(attributes && Array.isArray(attributes)) {
                        let picked = global.hdb_schema[search_obj.schema][search_obj.table].attributes.find(o => o.attribute === item);
                        if(picked) return picked;
                    }
                });
                if(valid_attributes && valid_attributes.length > 0) {
                    search_obj.get_attributes = valid_attributes;
                }
                caller(null, search_obj);
            },
            search.searchByHash,
            (existing_records, caller) => {
                if( existing_records.length === 0) {
                    return caller(NO_RESULTS);
                }
                hash_attribute = global.hdb_schema[update_object.schema][update_object.table].hash_attribute;
                caller(null, update_object, hash_attribute, existing_records);
            },
            compareUpdatesToExistingRecords,
            unlinkFiles,
            (update_objects, caller) => {
                update_object.records = update_objects;

                update_objects.forEach((record)=>{
                    // need to make sure the attribute is a string for the lodash comparison below.
                    tracker.update_ids.push(autocast(record[hash_attribute]));
                });

                caller(null, update_object);
            },
            checkAttributeSchema,
            processData
        ], (err) => {
            //TODO: This is ugly and string compare is slow.  Refactor this when we bring in promises.
            if (err && NO_RESULTS !== err) {
                callback(err);
                return;
            }

            let skipped_hashes = _.difference(tracker.all_ids, tracker.update_ids);
            let return_object = {
                message: `updated ${tracker.update_ids.length} of ${tracker.all_ids.length} records`,
                update_hashes: tracker.update_ids,
                skipped_hashes: skipped_hashes
            };

            callback(null, return_object);
            return;
        });
    } catch(e){
        callback(e);
    }
}

function compareUpdatesToExistingRecords(update_object, hash_attribute, existing_records, callback) {

    if(!existing_records || existing_records.length === 0) { return callback('No Records Found'); }
    let base_path = hdb_path + '/' + update_object.schema + '/' + update_object.table + '/';

    let unlink_paths = [];
    let update_objects = [];

    try {
        let update_map = _.keyBy(update_object.records, function(record) {
            return record[hash_attribute];
        });

        existing_records.forEach((existing_record) => {
            let update_record = update_map[existing_record[hash_attribute]];
            if (!update_record) {
                return;
            }
            let update = {};

            for (let attr in update_record) {
                if (autocast(existing_record[attr]) !== autocast(update_record[attr])) {
                    update[attr] = update_record[attr];

                    let {value_path} = valueConverter(existing_record[attr]);

                    if (!h_utils.isEmpty(existing_record[attr]) && !h_utils.isEmpty(value_path)) {
                        unlink_paths.push(`${base_path}${attr}/${value_path}/${existing_record[hash_attribute]}.hdb`);
                    }

                    if (h_utils.isEmpty(update_record[attr])) {
                        unlink_paths.push(`${base_path}__hdb_hash/${attr}/${existing_record[hash_attribute]}.hdb`);
                    }
                }
            }

            if (Object.keys(update).length > 0) {
                update[hash_attribute] = existing_record[hash_attribute];
                update_objects.push(update);
            }
        });

        callback(null, unlink_paths, update_objects);
    } catch(e) {
        callback(e);
    }
}

/**
 *
 * @param unlink_paths
 * @param update_objects
 * @param callback
 */
function unlinkFiles(unlink_paths, update_objects, callback) {
    async.each(unlink_paths, (path, caller)=>{
        fs.unlink(path, (err)=>{
            if(err){
                if(err.code === 'ENOENT'){
                    return caller();
                }
                logger.error(err);
            }
            caller();
        });
    }, (error)=>{
        if(error){
            callback(error);
            return;
        }
        callback(null, update_objects);
    });
}

/**
 * This function is used to remove HDB internal values (such as HDB_INTERNAL_PATH) from the record when it
 * is stringified.
 * @param key - the key of the record
 * @param value - the value of the record
 * @returns {*}
 */
function filterHDBValues(key, value) {
    if(key === HDB_PATH_KEY) {
        return undefined;
    }
    else {
        return value;
    }
}


/**
 * This function takes every row, explodes it by attribute and sends the data on to be written to disk
 * @param insert_object
 * @param callerback
 */
function checkAttributeSchema(insert_object, callerback) {
    if(!insert_object) { return callerback("Empty Object", null); }

    try {
        let table_schema = global.hdb_schema[insert_object.schema][insert_object.table];
        let hash_attribute = table_schema.hash_attribute;
        let epoch = new Date().valueOf();

        let insert_objects = [];

        let folders = {};
        let hash_paths = {};
        let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
        let operation = insert_object.operation;
        insert_object.records.forEach((record) => {
            if (record[HDB_PATH_KEY] === undefined && operation !== 'update') {
                return;
            }
            let exploded_row = {
                hash_value: null,
                raw_data: [],
                links: []
            };

            hash_paths[`${base_path}__hdb_hash/${hash_attribute}/${record[hash_attribute]}.hdb`] = '';
            for (let property in record) {
                if (record[property] === null || record[property] === undefined || record[property] === '' || property === HDB_PATH_KEY) {
                    continue;
                }

                let {value, value_path} = valueConverter(record[property]);
                let attribute_file_name = record[hash_attribute] + '.hdb';
                let attribute_path = base_path + property + '/' + value_path;

                folders[`${base_path}__hdb_hash/${property}`] = "";
                exploded_row.raw_data.push({
                    file_name: `${base_path}__hdb_hash/${property}/${attribute_file_name}`,
                    value: value
                });
                if (property !== hash_attribute) {
                    folders[attribute_path] = "";

                    exploded_row.links.push({
                        link: `${base_path}__hdb_hash/${property}/${attribute_file_name}`,
                        file_name: `${attribute_path}/${attribute_file_name}`
                    });
                } else {
                    folders[attribute_path] = "";
                    exploded_row.hash_value = value;
                    exploded_row.raw_data.push({
                        file_name: `${attribute_path}/${epoch}.hdb`,
                        // Need to use the filter to remove the HDB_INTERNAL_PATH from the record before it is added to a file.
                        value: JSON.stringify(record, filterHDBValues)
                    });
                }
            }
            insert_objects.push(exploded_row);
        });

        let data_wrapper = {
            data_folders: Object.keys(folders),
            data: insert_objects,
            hash_paths: hash_paths,
            operation: insert_object.operation
        };

        if (insert_object.hdb_auth_header) {
            data_wrapper.hdb_auth_header = insert_object.hdb_auth_header;
        }
        return callerback(null, data_wrapper);
    } catch(e){
        return callerback(e);
    }
}

/**
 * takes a raw value from an attribute, replaces "/", ".", ".." with unicode equivalents and returns the value, escaped value & the value path
 * @param raw_value
 * @returns {{value: string, value_stripped: string, value_path: string}}
 */
function valueConverter(raw_value){
    let value;
    try {
        value = typeof raw_value === 'object' ? JSON.stringify(raw_value) : raw_value;
    } catch(e){
        logger.error(e);
        value = raw_value;
    }
    let value_stripped = String(h_utils.escapeRawValue(value));
    let value_path = Buffer.byteLength(value_stripped) > 255 ? truncate(value_stripped, 255) + '/blob' : value_stripped;

    return {
        value: value,
        value_stripped: value_stripped,
        value_path: value_path
    };
}

/**
 * Checks to verify which records already exist in the database
 * @param hash_paths
 * @param callback
 */
function checkRecordsExist(insert_object, skipped_records, inserted_records, callback) {
    let table_schema = global.hdb_schema[insert_object.schema][insert_object.table];
    async.map(insert_object.records, function(record, inner_callback) {
        if(record[HDB_PATH_KEY]) {
            fs.access(record[HDB_PATH_KEY], (err) => {
                if (err && err.code === 'ENOENT') {
                    inserted_records.push(autocast(record[table_schema.hash_attribute]));
                    inner_callback();
                } else {
                    record[HDB_PATH_KEY] = undefined;
                    skipped_records.push(autocast(record[table_schema.hash_attribute]));
                    inner_callback();
                }
            });
        } else {
            skipped_records.push(autocast(record[table_schema.hash_attribute]));
            inner_callback();
        }
    }, function(err){
        if (err) {
            callback(err);
        } else {
            callback();
        }
    });
}

/**
 * wrapper function that orchestrates the record creattion on disk
 * @param data_wrapper
 * @param callback
 */
function processData(data_wrapper, callback) {
    async.waterfall([
        createFolders.bind(null, data_wrapper, data_wrapper.data_folders),
        writeRecords.bind(null, data_wrapper.data)
    ], (err) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

/**
 * Iterates the rows and row by row writes the raw data plust the associated hard links.  The limit is set manage the event loop.  on large batches the event loop will get bogged down.
 * @param data
 * @param callback
 */
function writeRecords(data, callback){
    async.eachLimit(data, WRITE_RECORDS_ASYNC_EACH_LIMIT, (record, callback2)=>{
        async.waterfall([
            writeRawDataFiles.bind(null, record.raw_data),
            writeLinkFiles.bind(null, record.links)
        ], (err)=>{
            if(err){
                winston.error(err);
            }
            callback2();
        });
    }, (error)=>{
        if(error){
            return callback(error);
        }

        callback();
    });
}

/**
 * writes the raw data files to disk
 * @param data
 * @param callback
 */
function writeRawDataFiles(data, callback) {
    async.each(data, (attribute, caller) => {
        fs.writeFile(attribute.file_name, attribute.value, (err) => {
            if (err) {
                caller(err);
                return;
            }
            caller();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

/**
 * creates the hard links to the raw data files
 * @param links
 * @param callback
 */
function writeLinkFiles(links, callback) {
    async.each(links, (link, caller) => {
        fs.link(link.link, link.file_name, (err) => {
            if (err && err.code !== 'EEXIST') {
                caller(err);
                return;
            }
            caller();
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 * @param callback
 */
function createFolders(data_wrapper,folders, callback) {

    let folder_created_flag = false;
    async.eachLimit(folders, CREATE_FOLDERS_ASYNC_EACH_LIMIT, (folder, caller) => {
        mkdirp(folder, (err, created_folder) => {
            if (err) {
                caller(err);
                return;
            }

            if(folder.indexOf('/__hdb_hash/') >= 0 && created_folder) {
                folder_created_flag = true;

                createNewAttribute(data_wrapper,folder, (error)=>{
                    return caller();
                });
            } else {
                return caller();
            }
        });
    }, function (err) {
        if (err) {
            callback(err);
            return;
        }

        if( folder_created_flag ) {
            signalling.signalSchemaChange({type: 'schema'});
        }

        callback();
    });
}

/**
 *
 * @param base_folder
 * @param callback
 */
function createNewAttribute(data_wrapper,folder, callback) {

    let base_parts = folder.replace(hdb_path, '').split('/');
    let attribute_object = {
        schema:base_parts[1],
        table:base_parts[2],
        attribute:base_parts[base_parts.length - 1]
    };

    if(data_wrapper.hdb_auth_header){
        attribute_object.hdb_auth_header = data_wrapper.hdb_auth_header;
    }

    schema.createAttribute(attribute_object, (err, data)=> {
        if(err) {
            logger.error(err);
        }

        callback();
    });
}

const schema = require('../data_layer/schema');