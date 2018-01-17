'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */

const insert_validator = require('../validation/insertValidator.js'),
    fs = require('graceful-fs'),
    async = require('async'),
    path = require('path'),
    mkdirp = require('mkdirp'),
    search = require('./search'),
    winston = require('../utility/logging/winston_logger'),
    _ = require('lodash'),
    truncate = require('truncate-utf8-bytes'),
    PropertiesReader = require('properties-reader'),
    autocast = require('autocast'),
    signalling = require('../utility/signalling'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));


const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');
const regex = /\//g,
    hash_regex = /^[a-zA-Z0-9-_]+$/;
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
function validation(write_object, callback){
    global_schema.getTableSchema(write_object.schema, write_object.table, (err, table_schema) => {
        if (err) {
            callback(err);
            return;
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
            } else if(regex.test(record[hash_attribute])) {
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
                for (let r in insert_object.records) {
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
            callback('invalid operation, must be update');
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

                    let value = typeof existing_record[attr] === 'object' ? JSON.stringify(existing_record[attr]) : existing_record[attr];
                    let value_stripped = String(value).replace(regex, '');
                    value_stripped = Buffer.byteLength(value_stripped) > 255  ? truncate(value_stripped, 255) + '/blob' : value_stripped;

                    if (existing_record[attr] !== null && existing_record[attr] !== undefined) {
                        unlink_paths.push(`${base_path}${attr}/${value_stripped}/${existing_record[hash_attribute]}.hdb`);
                    }

                    if (update_record[attr] === null || update_record[attr] === undefined) {
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
                winston.error(err);
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
 *
 * @param insert_object
 * @param callerback
 */
function checkAttributeSchema(insert_object, callerback) {
    if(!insert_object) { return callback("Empty Object", null); }
    let table_schema = global.hdb_schema[insert_object.schema][insert_object.table];
    let hash_attribute = table_schema.hash_attribute;
    let epoch = new Date().valueOf();

    let insert_objects = [];
    let symbolic_links = [];

    let folders = {};
    let hash_folders = {};
    let hash_paths = {};
    let base_path = hdb_path + '/' + insert_object.schema + '/' + insert_object.table + '/';
    let operation = insert_object.operation;

    async.each(insert_object.records, function (record, callback) {
        //Update function does not set base path, so we should not exit if this is an update and path is undefined.
        if(record[HDB_PATH_KEY] === undefined && operation !== 'update') {
            return callback();
        }
        let attribute_objects = [];
        let link_objects = [];
        hash_paths[`${base_path}__hdb_hash/${hash_attribute}/${record[hash_attribute]}.hdb`] = '';
        for (let property in record) {
            if(record[property] === null || record[property] === undefined || record[property] === '' || property === HDB_PATH_KEY){
                continue;
            }

            let value = typeof record[property] === 'object' ? JSON.stringify(record[property]) : record[property];
            let value_stripped = String(value).replace(regex, '');
            let value_path = Buffer.byteLength(value_stripped) > 255 ? truncate(value_stripped, 255) + '/blob' : value_stripped;
            let attribute_file_name = record[hash_attribute] + '.hdb';
            let attribute_path = base_path + property + '/' + value_path;

            hash_folders[`${base_path}__hdb_hash/${property}`] = "";
            attribute_objects.push({
                file_name: `${base_path}__hdb_hash/${property}/${attribute_file_name}`,
                value: value
            });
            if (property !== hash_attribute) {
                folders[attribute_path] = "";

                link_objects.push({
                    link: `${base_path}/__hdb_hash/${property}/${attribute_file_name}`,
                    file_name: `${attribute_path}/${attribute_file_name}`
                });
            } else {
                hash_folders[attribute_path] = "";
                attribute_objects.push({
                    file_name: `${attribute_path}/${epoch}.hdb`,
                    // Need to use the filter to remove the HDB_INTERNAL_PATH from the record before it is added to a file.
                    value: JSON.stringify(record, filterHDBValues)
                });
            }
        }
        insert_objects = insert_objects.concat(attribute_objects);
        symbolic_links = symbolic_links.concat(link_objects);
        callback();
    }, function (err) {
        if (err) {
            callerback(err);
            return;
        }
        let data_wrapper = {
            data_folders: Object.keys(hash_folders),
            data: insert_objects,
            link_folders: Object.keys(folders),
            links: symbolic_links,
            hash_paths: hash_paths,
            operation: insert_object.operation
        };

        return callerback(null, data_wrapper);
    });
}

/**
 *
 * @param hash_paths
 * @param callback
 */
function checkRecordsExist(insert_object, skipped_records, inserted_records, callback) {
    let table_schema = global.hdb_schema[insert_object.schema][insert_object.table];
    async.map(insert_object.records, function(record, inner_callback) {
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
    }, function(err){
        if (err) {
            callback(err);
        } else {
            callback();
        }
    });
}

/**
 *
 * @param data_wrapper
 * @param callback
 */
function processData(data_wrapper, callback) {
    async.parallel([
        writeRawData.bind(null, data_wrapper.data_folders, data_wrapper.data),
        writeLinks.bind(null, data_wrapper.link_folders, data_wrapper.links),
    ], (err, results) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

/**
 *
 * @param folders
 * @param data
 * @param callback
 */
function writeRawData(folders, data, callback) {
    async.waterfall([
        createFolders.bind(null, folders),
        writeRawDataFiles.bind(null, data)
    ], (err, results) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

/**
 *
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
 *
 * @param folders
 * @param links
 * @param callback
 */
function writeLinks(folders, links, callback) {
    async.waterfall([
        createFolders.bind(null, folders),
        writeLinkFiles.bind(null, links)
    ], (err, results) => {
        if (err) {
            callback(err);
            return;
        }
        callback();
    });
}

/**
 *
 * @param links
 * @param callback
 */
function writeLinkFiles(links, callback) {
    async.each(links, (link, caller) => {
        fs.symlink(link.link, link.file_name, (err) => {
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
 *
 * @param folders
 * @param callback
 */
function createFolders(folders, callback) {
    let folder_created_flag = false;
    async.each(folders, (folder, caller) => {
        mkdirp(folder, (err, created_folder) => {
            if (err) {
                caller(err);
                return;
            }

            if(folder.indexOf('/__hdb_hash/') >= 0 && created_folder) {
                folder_created_flag = true;
                createNewAttribute(folder, (error)=>{
                    caller();
                });
            } else {
                caller();
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
function createNewAttribute(base_folder, callback){
    let base_parts = base_folder.replace(hdb_path, '').split('/');
    let attribute_object = {
        schema:base_parts[1],
        table:base_parts[2],
        attribute:base_parts[base_parts.length - 1]
    };

    schema.createAttribute(attribute_object, (err, data)=>{
        if(err){
            winston.error(err);
        }

        callback();
    });
}

const schema = require('../data_layer/schema');