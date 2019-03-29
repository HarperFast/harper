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
const env = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const mkdirp = require('../utility/fs/mkdirp');
const write_file = require('../utility/fs/writeFile');
const unlink = require('../utility/fs/unlink');
const pool_handler = require('../utility/threads/poolHandler');
const exploder = require('./dataWriteProcessor');
const {promisify} = require('util');
const ExplodedObject = require('./ExplodedObject');
const WriteProcessorObject = require('./WriteProcessorObject');
const HDB_Pool = require('threads').Pool;

// Search is used in the installer, and the base path may be undefined when search is instantiated.  Dynamically
// get the base path from the environment manager before using it.
let hdb_path = function() {
    return `${env.getHdbBasePath()}/schema/`;
};

//This is an internal value that should not be written to the DB.
//const HDB_PATH_KEY = hdb_terms.INSERT_MODULE_ENUM.HDB_PATH_KEY;
const CHUNK_SIZE = hdb_terms.INSERT_MODULE_ENUM.CHUNK_SIZE;

//for release 2.0 we need to turn off threading.  this variable will control the enable/disable
const ENABLE_THREADING = false;

const INTERNAL_ERROR_MESSAGE = 'An internal error occurred, please check the logs for more information.';

const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';

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
 *  Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} write_object
 * @returns {Promise<{table_schema, hashes: any[], attributes: string[]}>}
 */
async function validation(write_object){
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
        throw validator;
    }

    if(!Array.isArray(write_object.records)) {
        throw new Error('records must be an array');
    }

    let hash_attribute = table_schema.hash_attribute;
    let dups = new Set();
    let attributes = {};
    write_object.records.forEach((record)=>{
        if(!h_utils.isEmpty(record[hash_attribute]) && record[hash_attribute] !== '' && dups.has(h_utils.autoCast(record[hash_attribute]))){
            record.skip = true;
        }

        dups.add(h_utils.autoCast(record[hash_attribute]));

        for (let attr in record) {
            attributes[attr] = 1;
        }
    });

    //in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
    attributes[hash_attribute] = 1;

    return {
        table_schema: table_schema,
        hashes: Array.from(dups),
        attributes: Object.keys(attributes)
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
 * Inserts data specified in the insert_object parameter.
 * @param insert_object
 */
async function insertData(insert_object){
    let pool = undefined;
    try {
        let epoch = Date.now();

        if (insert_object.operation !== 'insert') {
            throw new Error('invalid operation, must be insert');
        }

        let {table_schema, attributes} = await validation(insert_object);

        let { written_hashes, skipped, ...data_wrapper} = await processRows(insert_object, attributes, table_schema, epoch, null, pool);
        pool = data_wrapper.pool;

        await checkForNewAttributes(insert_object.hdb_auth_header, table_schema, attributes);

        pool = await processData(data_wrapper, pool);

        let return_object = {
            message: `inserted ${written_hashes.length} of ${insert_object.records.length} records`,
            inserted_hashes: written_hashes,
            skipped_hashes: skipped
        };

        if(pool instanceof HDB_Pool){
            pool.killAll();
        }
        return return_object;
    } catch(e){
        if(pool instanceof HDB_Pool){
            pool.killAll();
        }
        throw (e);
    }
}

/**
 * Updates the data in the update_object parameter.
 * @param update_object - The data that will be updated in the database
 */
async function updateData(update_object){
    let pool = undefined;
    try {
        let epoch = Date.now();

        if (update_object.operation !== 'update') {
            throw new Error('invalid operation, must be update');
        }

        let {table_schema, hashes, attributes} = await validation(update_object);

        let existing_rows = await getExistingRows(table_schema, hashes, attributes);

        if(h_utils.isEmptyOrZeroLength(existing_rows)){
            //TODO finish this return
            return;
        }

        let existing_map =  _.keyBy(existing_rows, function(record) {
            return record[table_schema.hash_attribute];
        });

        let { written_hashes, skipped, unlinks, ...data_wrapper} = await processRows(update_object, attributes, table_schema, epoch, existing_map, pool);
        pool = data_wrapper.pool;

        await checkForNewAttributes(update_object.hdb_auth_header, table_schema, attributes);

        pool = await unlinkFiles(unlinks, pool);

        pool = await processData(data_wrapper, pool);

        let return_object = {
            message: `updated ${written_hashes.length} of ${update_object.records.length} records`,
            update_hashes: written_hashes,
            skipped_hashes: skipped
        };

        if(pool instanceof HDB_Pool){
            pool.killAll();
        }

        return return_object;
    } catch(e){
        if(pool instanceof HDB_Pool){
            pool.killAll();
        }
        throw (e);
    }
}

/**
 * performs a bulk search_by_hash for the defined hashes
 * @param table_schema
 * @param hashes
 * @param attributes
 * @returns {Promise<void>}
 */
async function getExistingRows(table_schema, hashes, attributes){
    try {
        let existing_attributes = checkForExistingAttributes(table_schema, attributes);
        if (h_utils.isEmptyOrZeroLength(existing_attributes)) {
            throw new Error('no attributes to update');
        }

        let search_object = {
            schema: table_schema.schema,
            table: table_schema.name,
            hash_values: hashes,
            get_attributes: existing_attributes
        };

        let existing_records = await p_search_by_hash(search_object);
        return existing_records;
    } catch(e) {
        logger.error(e);
        throw new Error(e);
    }
}

/**
 * wrapper function which orchestrates the multi-process pool, if needed, or calls the function directly
 * @param insert_object
 * @param attributes
 * @param table_schema
 * @param epoch
 * @param existing_rows
 * @param pool
 * @returns {Promise<ExplodedObject|ExplodedObject>}
 */
async function processRows(insert_object, attributes, table_schema, epoch, existing_rows, pool){
    let data_wrapper;
    if(ENABLE_THREADING === true && insert_object.records.length > CHUNK_SIZE){
        if(!(pool instanceof HDB_Pool)){
            pool = new HDB_Pool();
        }

        let chunks = _.chunk(insert_object.records, CHUNK_SIZE);
        let folders = new Set();
        let raw_data = [];
        let skipped = [];
        let written_hashes = [];
        let unlinks = [];

        await Promise.all(
            chunks.map(async chunk => {
                try {
                    let exploder_object = new WriteProcessorObject(hdb_path(), insert_object.operation, chunk, table_schema, attributes, epoch, existing_rows);

                    let result = await pool.run('../data_layer/dataWriteProcessor').send(exploder_object).promise();
                    //each process returns an instance of its data we need to consolidate each result
                    if (result) {
                        result.folders.forEach((folder) => {
                            folders.add(folder);
                        });
                        result.raw_data.forEach((data) => {
                            raw_data.push(data);
                        });
                        result.skipped.forEach((data) => {
                            skipped.push(data);
                        });
                        result.written_hashes.forEach((data) => {
                            written_hashes.push(data);
                        });
                        result.unlinks.forEach((data) => {
                            unlinks.push(data);
                        });
                    }
                } catch(e) {
                    logger.error(e);
                }
            })
        );
        chunks = undefined;
        data_wrapper = new ExplodedObject(written_hashes, skipped, Array.from(folders), raw_data, unlinks);
    } else{
        let exploder_object = new WriteProcessorObject(hdb_path(), insert_object.operation, insert_object.records, table_schema, attributes, epoch, existing_rows);
        data_wrapper = await exploder(exploder_object);
    }
    data_wrapper.pool = pool;
    return data_wrapper;
}

/**
 *deletes files in bulk
 * @param unlink_paths
 * @param pool
 */
async function unlinkFiles(unlink_paths, pool) {
    try {
        if (ENABLE_THREADING === true && unlink_paths.length > CHUNK_SIZE) {
            if(!(pool instanceof HDB_Pool)){
                pool = new HDB_Pool();
            }
            await pool_handler(pool, unlink_paths, CHUNK_SIZE, '../utility/fs/unlink');
        } else {
            await unlink(unlink_paths);
        }

        return pool;
    } catch(e) {
        logger.error(e);
    }
}

/**
 * wrapper function that orchestrates the record creation on disk
 * @param data_wrapper
 * @param pool
 */
async function processData(data_wrapper, pool) {
    pool = await createFolders(data_wrapper.folders, pool);
    pool = await writeRawDataFiles(data_wrapper.raw_data, pool);

    return pool;
}

/**
 * writes the raw data files to disk
 * @param data
 * @param pool
 */
async function writeRawDataFiles(data, pool) {
    try {
        if (ENABLE_THREADING === true && data.length > CHUNK_SIZE) {
            if(!(pool instanceof HDB_Pool)){
                pool = new HDB_Pool();
            }
            await pool_handler(pool, data, CHUNK_SIZE, '../utility/fs/writeFile');
        } else {
            await write_file(data);
        }

        return pool;
    } catch(e) {
        logger.error(e);
    }
}

/**
 * creates all of the folders necessary to hold the raw files and hard links
 * @param folders
 * @param pool
 */
async function createFolders(folders, pool) {
    try {
        if (ENABLE_THREADING === true && folders.length > CHUNK_SIZE) {
            if(!(pool instanceof HDB_Pool)){
                pool = new HDB_Pool();
            }
            await pool_handler(pool, folders, CHUNK_SIZE, '../utility/fs/mkdirp');
        } else {
            await mkdirp(folders);
        }

        return pool;
    } catch (e) {
        logger.error(e);
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
    try {
        if (h_utils.isEmptyOrZeroLength(data_attributes)) {
            return;
        }

        let raw_attributes = [];
        if (!h_utils.isEmptyOrZeroLength(table_schema.attributes)) {
            table_schema.attributes.forEach((attribute) => {
                raw_attributes.push(attribute.attribute);
            });
        }

        let new_attributes = data_attributes.filter(attribute => {
            return raw_attributes.indexOf(attribute) < 0;
        });

        if (new_attributes.length === 0) {
            return;
        }

        await Promise.all(
            new_attributes.map(async attribute => {
                await createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
            })
        );
    } catch(e){
        logger.error(e);
        throw new Error(e);
    }
}

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist
 * @param table_schema
 * @param data_attributes
 * @returns {*[]}
 */
function checkForExistingAttributes(table_schema, data_attributes){
    if(h_utils.isEmptyOrZeroLength(data_attributes)){
        return;
    }

    let raw_attributes = [];
    if(!h_utils.isEmptyOrZeroLength(table_schema.attributes)){
        table_schema.attributes.forEach((attribute)=>{
            raw_attributes.push(attribute.attribute);
        });
    }

    let existing_attributes = data_attributes.filter(attribute =>{
        return raw_attributes.indexOf(attribute) >= 0;
    });

    return existing_attributes;
}

/**
 * check the existing schema and creates new attributes based on what the incoming records have
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
    } catch(e){
        //if the attribute already exists we do not want to stop the insert
        if(typeof e === 'string' && e.indexOf(ATTRIBUTE_ALREADY_EXISTS) > -1){
            logger.warn(e);
        } else {
            throw e;
        }
    }
}

const schema = require('../data_layer/schema');
const p_create_attribute = promisify(schema.createAttribute);
