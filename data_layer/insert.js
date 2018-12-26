'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */

const insert_validator = require('../validation/insertValidator.js');
const fs = require('fs-extra');
const path = require('path');
const h_utils = require('../utility/common_utils');
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const _ = require('lodash');
const truncate = require('truncate-utf8-bytes');
const PropertiesReader = require('properties-reader');
const autocast = require('autocast');
const signalling = require('../utility/signalling');
const hdb_terms = require('../utility/hdbTerms');
const {promisify} = require('util');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');

//This is an internal value that should not be written to the DB.
const HDB_PATH_KEY = 'HDB_INTERNAL_PATH';
const HDB_AUTH_HEADER = 'hdb_auth_header';
const HDB_USER_DATA_KEY = 'hdb_user';

module.exports = {
    insertCB: insertDataCB,
    updateCB: updateDataCB,
    insert: insertData,
    update: updateData
};
//this must stay after the export to correct a circular dependency issue
const global_schema = require('../utility/globalSchema');

const p_global_schema = promisify(global_schema.getTableSchema);
const p_search_by_hash = promisify(search.searchByHash);
const  p_fs_access = promisify(fs.access);

/**
 * This validation is called before an insert or update is performed with the write_object.
 *
 * @param write_object - the object that will be written post-validation
 * @param callback - The caller
 */
async function validation(write_object) {
    // Need to validate these outside of the validator as the getTableSchema call will fail with
    // invalid values.
    if(h_utils.isEmpty(write_object)) {
        throw new Error('invalid update parameters defined.');
    }
    if(h_utils.isEmptyOrZeroLength(write_object.schema) ) {
        throw new Error('invalid schema specified.');
    }
    if(h_utils.isEmptyOrZeroLength(write_object.table) ) {
        throw new Error('invalid table specified.');
    }

    let table_schema = await p_global_schema(write_object.schema, write_object.table);

    //validate insert_object for required attributes
    let validator = insert_validator(write_object);
    if (validator) {
        throw new Error(validator);
        return;
    }

    if(!Array.isArray(write_object.records)) {
        throw new Error('records must be an array');
    }

    let hash_attribute = table_schema.hash_attribute;
    let base_path = hdb_path + '/' + write_object.schema + '/' + write_object.table + '/';
    //validate that every record has hash_attribute populated
    let no_hash = false;
    let long_hash = false;
    let long_attribute = false;
    let bad_hash_value = false;
    write_object.dup_check = {};
    let attributes = [];
    for(let x = 0; x < write_object.records.length; x++){
        let record = write_object.records[x];
        let hash_value = record[hash_attribute];
        if(hash_value === null || hash_value === undefined){
            no_hash = true;
            break;
        } else if(hdb_terms.FORWARD_SLASH_REGEX.test(hash_value)) {
            bad_hash_value = true;
            break;
        } else if(Buffer.byteLength(String(hash_value)) > 250){
            long_hash = true;
            break;
        }

        //evaluate that there are no attributes who have a name longer than 250 characters
        Object.keys(record).forEach((attribute)=>{
            if(Buffer.byteLength(String(attribute)) > 250) {
                long_attribute = true;
            }
        });
        if(long_attribute) {
            break;
        }

        //dup check
        // If duplicate, we don't assign the HDB_INTERNAL_PATH internal attribute so it will be skipped later.
        if(write_object.dup_check[hash_value]) {
            continue;
        }
        write_object.dup_check[hash_value] = {};
        let path = `${base_path}__hdb_hash/${hash_attribute}/${hash_value}.hdb`;
        //Internal record that is removed if the record exists.  Should not be written to the DB.
        write_object.records[x][HDB_PATH_KEY] = path;
        //end dup check
    }

    if (no_hash) {
        throw new Error('transaction aborted due to record(s) with no hash value.');
    }

    if (long_hash) {
        throw new Error('transaction aborted due to record(s) with a hash value that exceeds 250 bytes.');
    }

    if (bad_hash_value) {
        throw new Error('transaction aborted due to record(s) with a hash value that contains a forward slash.');
    }

    if (long_attribute) {
        throw new Error('transaction aborted due to record(s) with an attribute that exceeds 250 bytes.');
    }

    return table_schema;
}

function insertDataCB(insert_object, callback){
    try{
        insertData(insert_object).then((results)=>{
            callback(null, results);
        }).catch(err=>{
            callback(err);
        });

    } catch(e){
        callback(e);
    }
}

function updateDataCB(insert_object, callback){
    try{
        updateData(insert_object).then((results)=>{
            callback(null, results);
        }).catch(err=>{
            callback(err);
        });

    } catch(e){
        callback(e);
    }
}

/**
 * Inserts data specified in the insert_object parameter.  Currently if even a single entity in insert_object already exists,
 * the function will return and no other inserts will be performed.
 * @param insert_object
 * @param callback
 */
async function insertData(insert_object){
    try {
        if (insert_object.operation !== 'insert') {
            throw new Error('invalid operation, must be insert');
        }
        let inserted_records = [];
        let skipped_records = [];

        let table_schema = await validation(insert_object);
        let hash_attribute = table_schema.hash_attribute;

        insert_object.dup_check = {};

/*        //TODO possibly move the duplicate check to validate
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
        }*/

        await checkRecordsExist(insert_object, skipped_records, inserted_records, table_schema);
        let data_wrapper = checkAttributeSchema(insert_object, table_schema);
        await processData(data_wrapper);

        let return_object = {
            message: `inserted ${inserted_records.length} of ${insert_object.records.length} records`,
            inserted_hashes: inserted_records,
            skipped_hashes: skipped_records
        };

        return return_object;
    } catch(e){
        throw (e);
    }
}

/**
 * Updates the data in the update_object parameter.
 * @param update_object - The data that will be updated in the database
 */
async function updateData(update_object){
    try {
        if (update_object.operation !== 'update') {
            throw new Error('invalid operation, must be update');
        }
        let tracker = {
            all_ids:[],
            update_ids:[]
        };

        let table_schema = await validation(update_object);
        let hash_attribute = table_schema.hash_attribute;

        let attributes = new Set();
        let hashes = [];
        update_object.records.forEach((record) => {
            hashes.push(autocast(record[hash_attribute]));
            Object.keys(record).forEach((attribute) => {
                attributes.add(attribute);
            });
        });

        tracker.all_ids = hashes;

        let search_obj = {
            schema: update_object.schema,
            table: update_object.table,
            hash_values: hashes,
            get_attributes: Array.from(attributes)
        };

        // We need to filter out any new attributes from the update statement, as they will not be found in the searchByHash
        // call below and cause a validation error.
        let valid_attributes = search_obj.get_attributes.filter(function (item) {
            let attributes = global.hdb_schema[search_obj.schema][search_obj.table].attributes;
            if(attributes && Array.isArray(attributes)) {
                let picked = table_schema.attributes.find(o => o.attribute === item);
                if(picked) return picked;
            }
        });
        if(valid_attributes && valid_attributes.length > 0) {
            search_obj.get_attributes = valid_attributes;
        }

        let existing_records = await p_search_by_hash(search_obj);

        if( existing_records.length > 0) {
            let comparator = compareUpdatesToExistingRecords(update_object, hash_attribute, existing_records);
            await unlinkFiles(comparator.unlink_paths);

            update_object.records = comparator.update_objects;

            comparator.update_objects.forEach((record) => {
                // need to make sure the attribute is a string for the lodash comparison below.
                tracker.update_ids.push(autocast(record[hash_attribute]));
            });

            let data_wrapper = checkAttributeSchema(update_object, table_schema);
            await processData(data_wrapper);
        }

        let skipped_hashes = _.difference(tracker.all_ids, tracker.update_ids);
        return {
            message: `updated ${tracker.update_ids.length} of ${tracker.all_ids.length} records`,
            update_hashes: tracker.update_ids,
            skipped_hashes: skipped_hashes
        };
    } catch(e){
        throw (e);
    }
}

function compareUpdatesToExistingRecords(update_object, hash_attribute, existing_records) {

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

        return {unlink_paths:unlink_paths, update_objects: update_objects};
    } catch(e) {
        throw (e);
    }
}

/**
 *
 * @param unlink_paths
 */
async function unlinkFiles(unlink_paths) {
    await Promise.all(
        unlink_paths.map(async path=>{
            try {
                await fs.unlink(path);
            } catch(e){
                if(e.code !== 'ENOENT'){
                    logger.error(err);
                }
            }
        })
    );
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
 * @param table_schema
 */
function checkAttributeSchema(insert_object, table_schema) {
    if(!insert_object) {
        throw new Error("Empty Object");
    }

    let hash_attribute = table_schema.hash_attribute;
    let epoch = Date.now();

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
            if (record[property] === null || record[property] === undefined || record[property] === '' || property === HDB_PATH_KEY || property === HDB_AUTH_HEADER ||
                property === HDB_USER_DATA_KEY)
            {
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
    return  data_wrapper;
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
 * @param insert_object
 * @param skipped_records
 * @param inserted_records
 * @param table_schema
 */
async function checkRecordsExist(insert_object, skipped_records, inserted_records, table_schema) {
    let hash_attribute = table_schema.hash_attribute;
    await Promise.all(
        insert_object.records.map(async record => {
            if(record[HDB_PATH_KEY]) {
                try {
                    await p_fs_access(record[HDB_PATH_KEY]);
                    record[HDB_PATH_KEY] = undefined;
                    skipped_records.push(autocast(record[hash_attribute]));
                } catch(err){
                    if (err.code === 'ENOENT') {
                        inserted_records.push(autocast(record[hash_attribute]));
                    } else {
                        record[HDB_PATH_KEY] = undefined;
                        skipped_records.push(autocast(record[hash_attribute]));
                    }
                }
            } else {
                skipped_records.push(autocast(record[hash_attribute]));
            }
        })
    );
}

/**
 * wrapper function that orchestrates the record creation on disk
 * @param data_wrapper
 */
async function processData(data_wrapper) {
    await createFolders(data_wrapper, data_wrapper.data_folders);
    await writeRecords(data_wrapper.data);
}

/**
 * Iterates the rows and row by row writes the raw data plust the associated hard links.  The limit is set manage the event loop.  on large batches the event loop will get bogged down.
 * @param data
 */
async function writeRecords(data){
    await Promise.all(data.map(async (record) => {
        try {
            await writeRawDataFiles(record.raw_data);
            await writeLinkFiles(record.links);
        } catch(e) {
            logger.error(e);
        }
    }));
}

/**
 * writes the raw data files to disk
 * @param data
 * @param callback
 */
async function writeRawDataFiles(data) {
    await Promise.all(
        data.map(async attribute => {
            await fs.writeFile(attribute.file_name, attribute.value);
        })
    );
}

/**
 * creates the hard links to the raw data files
 * @param links
 * @param callback
 */
async function writeLinkFiles(links) {
    await Promise.all(
        links.map(async link => {
            try {
                await fs.link(link.link, link.file_name);
            } catch(e){
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
        })
    );
}

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 * @param callback
 */
async function createFolders(data_wrapper,folders) {

    let folder_created_flag = false;

    await Promise.all(
        folders.map(async folder=>{
            let created_folder = await fs.mkdirp(folder);
            //todo move this to validation?
            if(created_folder && folder.indexOf('/__hdb_hash/') >= 0 ) {
                folder_created_flag = true;

                await createNewAttribute(data_wrapper,folder);
            }
        })
    );

    if( folder_created_flag ) {
        signalling.signalSchemaChange({type: 'schema'});
    }
}

/**
 *
 * @param data_wrapper
 * @param folder
 */
async function createNewAttribute(data_wrapper,folder) {

    let base_parts = folder.replace(hdb_path, '').split('/');
    let attribute_object = {
        schema:base_parts[1],
        table:base_parts[2],
        attribute:base_parts[base_parts.length - 1]
    };

    if(data_wrapper.hdb_auth_header){
        attribute_object.hdb_auth_header = data_wrapper.hdb_auth_header;
    }

    try {
        await p_create_attribute(attribute_object);
    } catch(e) {
        logger(e);
    }
}

const schema = require('../data_layer/schema');
const p_create_attribute = promisify(schema.createAttribute);