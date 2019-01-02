'use strict';

/***
 * INSERT.JS
 *
 * This module is used to validate and insert or update data.  Note insert.update should be used over the update module,
 * as the update module is meant to be used in more specific circumstances.
 */

const insert_validator = require('../validation/insertValidator.js');
const path = require('path');
const h_utils = require('../utility/common_utils');
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const _ = require('lodash');
const truncate = require('truncate-utf8-bytes');
const PropertiesReader = require('properties-reader');
const autocast = require('autocast');
const hdb_terms = require('../utility/hdbTerms');
const file_access = require('../utility/fs/insertFileAccess');
const mkdirp = require('../utility/fs/mkdirp');
const write_file = require('../utility/fs/writeFile');
const link = require('../utility/fs/link');
const unlink = require('../utility/fs/unlink');
const pool_handler = require('../utility/threads/poolHandler');
const {promisify} = require('util');
const FileObject = require('../utility/fs/FileObject');
const LinkObject = require('../utility/fs/LinkObject');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));


const hdb_path = path.join(hdb_properties.get('HDB_ROOT'), '/schema');

//This is an internal value that should not be written to the DB.
const HDB_PATH_KEY = hdb_terms.INSERT_MODULE_ENUM.HDB_PATH_KEY;
const HDB_AUTH_HEADER = hdb_terms.INSERT_MODULE_ENUM.HDB_AUTH_HEADER;
const HDB_USER_DATA_KEY = hdb_terms.INSERT_MODULE_ENUM.HDB_USER_DATA_KEY;
const CHUNK_SIZE = hdb_terms.INSERT_MODULE_ENUM.CHUNK_SIZE;
const MAX_CHARACTER_SIZE = 250;

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

/**
 * This validation is called before an insert or update is performed with the write_object.
 *
 * @param write_object - the object that will be written post-validation
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
    let blank_attribute = false;
    write_object.dup_check = {};
    let attributes = new Set();
    let hashes = [];
    for(let x = 0; x < write_object.records.length; x++){
        let record = write_object.records[x];
        let hash_value = record[hash_attribute];
        hashes.push(autocast(hash_value));
        if(hash_value === null || hash_value === undefined){
            no_hash = true;
            break;
        } else if(hdb_terms.FORWARD_SLASH_REGEX.test(hash_value)) {
            bad_hash_value = true;
            break;
        } else if(Buffer.byteLength(String(hash_value)) > MAX_CHARACTER_SIZE){
            long_hash = true;
            break;
        }

        //evaluate that there are no attributes who have a name longer than 250 characters
        let record_keys = Object.keys(record);
        for(let k = 0; k < record_keys.length; k++){
            if(h_utils.isEmpty(record_keys[k]) || record_keys[k].trim() === ''){
                blank_attribute = true;
                break;
            }

            if(Buffer.byteLength(String(record_keys[k])) > MAX_CHARACTER_SIZE) {
                long_attribute = true;
                break;
            }
            attributes.add(record_keys[k]);
        }

        if(long_attribute || blank_attribute){
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
        throw new Error(`transaction aborted due to record(s) with a hash value that exceeds ${MAX_CHARACTER_SIZE} bytes.`);
    }

    if (bad_hash_value) {
        throw new Error('transaction aborted due to record(s) with a hash value that contains a forward slash.');
    }

    if (long_attribute) {
        throw new Error(`transaction aborted due to record(s) with an attribute that exceeds ${MAX_CHARACTER_SIZE} bytes.`);
    }

    if (blank_attribute) {
        throw new Error('transaction aborted due to record(s) with an attribute name that is null, undefined or empty string');
    }

    return {
        table_schema:table_schema,
        attributes:[...attributes],
        hashes: hashes
    };
}

/**
 * Callback function for inserting data, remove when we are fully promised
 * @param insert_object
 * @param callback
 */
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

/**
 * Callback function for updating data, remove when we are fully promised
 * @param update_object
 * @param callback
 */
function updateDataCB(update_object, callback){
    try{
        updateData(update_object).then((results)=>{
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
 */
async function insertData(insert_object){
    try {
        if (insert_object.operation !== 'insert') {
            throw new Error('invalid operation, must be insert');
        }

        let {table_schema, attributes, hashes} = await validation(insert_object);

        await checkRecordsExist(insert_object, table_schema);

        await checkForNewAttributes(insert_object.hdb_auth_header, table_schema, attributes);

        let data_wrapper = checkAttributeSchema(insert_object, table_schema);
        await processData(data_wrapper);

        let inserted_hashes = _.difference(hashes, data_wrapper.skipped);
        let return_object = {
            message: `inserted ${data_wrapper.data.length} of ${insert_object.records.length} records`,
            inserted_hashes: inserted_hashes,
            skipped_hashes: data_wrapper.skipped
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

        let all_ids;
        let update_ids = [];

        let {table_schema, attributes, hashes} = await validation(update_object);
        let hash_attribute = table_schema.hash_attribute;

        all_ids = hashes;

        let search_obj = {
            schema: update_object.schema,
            table: update_object.table,
            hash_values: hashes,
            get_attributes: attributes
        };

        // We need to filter out any new attributes from the update statement, as they will not be found in the searchByHash
        // call below and cause a validation error.
        let valid_attributes = search_obj.get_attributes.filter(function (item) {
            let attributes = table_schema.attributes;
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
            let {unlink_paths, update_objects} = compareUpdatesToExistingRecords(update_object, hash_attribute, existing_records);
            await unlinkFiles(unlink_paths);

            update_object.records = update_objects;

            update_objects.forEach((record) => {
                // need to make sure the attribute is a string for the lodash comparison below.
                update_ids.push(autocast(record[hash_attribute]));
            });

            await checkForNewAttributes(update_object.hdb_auth_header, table_schema, attributes);

            let data_wrapper = checkAttributeSchema(update_object, table_schema);
            await processData(data_wrapper);
        }

        let skipped_hashes = _.difference(all_ids, update_ids);

        return {
            message: `updated ${update_ids.length} of ${all_ids.length} records`,
            update_hashes: update_ids,
            skipped_hashes: skipped_hashes
        };
    } catch(e){
        throw (e);
    }
}

/**
 * checks what records and attributes need to be updated
 * @param update_object
 * @param hash_attribute
 * @param existing_records
 * @returns {*}
 */
function compareUpdatesToExistingRecords(update_object, hash_attribute, existing_records) {

    if(!existing_records || existing_records.length === 0) {
        throw new Error('No Records Found');
    }
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
 *deletes files in bulk
 * @param unlink_paths
 */
async function unlinkFiles(unlink_paths) {
    if(unlink_paths.length > CHUNK_SIZE){
        await pool_handler(global.hdb_pool, unlink_paths,  CHUNK_SIZE, '../utility/fs/unlink');
    } else {
        await unlink(unlink_paths);
    }
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
    let skipped = [];

    insert_object.records.forEach((record) => {
        if (record[HDB_PATH_KEY] === undefined && operation !== 'update') {
            skipped.push(record[hash_attribute]);
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
            exploded_row.raw_data.push(
                new FileObject(`${base_path}__hdb_hash/${property}/${attribute_file_name}`, value)
            );
            if (property !== hash_attribute) {
                folders[attribute_path] = "";

                exploded_row.links.push(
                    new LinkObject(`${base_path}__hdb_hash/${property}/${attribute_file_name}`, `${attribute_path}/${attribute_file_name}`)
                );
            } else {
                folders[attribute_path] = "";
                exploded_row.hash_value = value;
                exploded_row.raw_data.push(
                    new FileObject(`${attribute_path}/${epoch}.hdb`,JSON.stringify(record, filterHDBValues))
                );
            }
        }
        insert_objects.push(exploded_row);
    });

    let data_wrapper = {
        data_folders: Object.keys(folders),
        data: insert_objects,
        hash_paths: hash_paths,
        operation: insert_object.operation,
        skipped: skipped
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
async function checkRecordsExist(insert_object, table_schema) {
    if(insert_object.records.length > CHUNK_SIZE) {
        let results = await pool_handler(global.hdb_pool, insert_object.records, CHUNK_SIZE, '../utility/fs/insertFileAccess');

        insert_object.records = results;
    } else {
        insert_object.records = await file_access(insert_object.records);
    }
}

/**
 * wrapper function that orchestrates the record creation on disk
 * @param data_wrapper
 */
async function processData(data_wrapper) {
    await createFolders(data_wrapper.data_folders);
    await writeRecords(data_wrapper.data);
}

/**
 * Iterates the rows and row by row writes the raw data plust the associated hard links.
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
 */
async function writeRawDataFiles(data) {
    if(data.length > CHUNK_SIZE){
        await pool_handler(global.hdb_pool, data,  CHUNK_SIZE, '../utility/fs/writeFile');
    } else {
        await write_file(data);
    }
}

/**
 * creates the hard links to the raw data files
 * @param links
 */
async function writeLinkFiles(links) {
    if(links.length > CHUNK_SIZE) {
        await pool_handler(global.hdb_pool, links, CHUNK_SIZE, '../utility/fs/link');
    } else {
        await link(links);
    }
}

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 */
async function createFolders(folders) {
    if(folders.length > CHUNK_SIZE) {
        await pool_handler(global.hdb_pool, folders, CHUNK_SIZE, '../utility/fs/mkdirp');
    } else {
        await mkdirp(folders);
    }
}

/**
 * Compares the existing schema attributes to the
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 * @returns {Promise<void>}
 */
async function checkForNewAttributes(hdb_auth_header, table_schema, data_attributes){
    if(h_utils.isEmptyOrZeroLength(data_attributes)){
        return;
    }

    let raw_attributes = [];
    if(!h_utils.isEmptyOrZeroLength(table_schema.attributes)){
        table_schema.attributes.forEach((attribute)=>{
            raw_attributes.push(attribute.attribute);
        });
    }

   let new_attributes = data_attributes.filter(attribute =>{
       return raw_attributes.indexOf(attribute) < 0;
   });

   if(new_attributes.length == 0) {
        return;
   }

   await Promise.all(
       new_attributes.map(async attribute=>{
           await createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
       })
   );
}

/**
 *
 * @param hdb_auth_header
 * @param schema
 * @param table
 * @param attribute
 */
async function createNewAttribute(hdb_auth_header,schema, table, attribute) {
    let attribute_object = {
        schema:schema,
        table:table,
        attribute:attribute
    };

    if(hdb_auth_header){
        attribute_object.hdb_auth_header = hdb_auth_header;
    }

    try {
        await p_create_attribute(attribute_object);
    } catch(e) {
        logger.error(e);
    }
}

const schema = require('../data_layer/schema');
const p_create_attribute = promisify(schema.createAttribute);