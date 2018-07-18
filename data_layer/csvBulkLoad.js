"use strict";

const insert = require('./insert');
const _ = require('lodash');
const async = require('async');
const validator = require('../validation/csvLoadValidator');
const request_promise = require('request-promise-native');
const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const {promisify} = require('util');
const alasql = require('alasql');
const logger = require('../utility/logging/harper_logger');

const RECORD_BATCH_SIZE = 1000;
const NEWLINE = '\n';
const unix_filename_regex = new RegExp(/[^-_.A-Za-z0-9]/);

// Promisify bulkLoad to avoid more of a refactor for now.
const p_bulk_load = promisify(bulkLoad);

module.exports = {
    csvDataLoad: csvDataLoad,
    csvURLLoad: csvURLLoad,
    csvFileLoad: csvFileLoad
};
/**
 * Load csv values specified as a string in the message 'data' field.
 *
 * @param json_message - An object representing the CSV file.
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @returns err - any errors found during the bulk load
 *
 */
async function csvDataLoad(json_message){
    let validation_msg = validator.dataObject(json_message);
    if (validation_msg) {
        throw new Error(validation_msg);
    }

    let csv_records = [];
    let bulk_load_result = {};
    // alasql csv parsing looks for the existence of at least 1 newline.  if not found, it will try to load a file which
    // results in a swallowed error written to the console, so we cram a newline at the end to avoid that error.
    if(json_message.data.indexOf(NEWLINE) < 0) {
        json_message.data = json_message.data + NEWLINE;
    }
    try {
        csv_records = await alasql.promise('SELECT * FROM CSV(?, {headers:true, separator:","})', [json_message.data]);
        if(csv_records && csv_records.length > 0 && validateColumnNames(csv_records[0])) {
            bulk_load_result = await p_bulk_load(csv_records, json_message.schema, json_message.table, json_message.action);
        } else {
            bulk_load_result.message = 'No records parsed from csv file.';
            logger.info(bulk_load_result.message);
        }
    } catch(e) {
        throw new Error(e);
    }

    return bulk_load_result.message;
}

/**
 * Load a csv file from a URL.
 *
 * @param json_message - An object representing the CSV file via URL.
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @returns err - any errors found during the bulk load
 *
 */
async function csvURLLoad(json_message) {
    let validation_msg = validator.urlObject(json_message);
    if (validation_msg) {
        throw new Error(validation_msg);
    }

    let csv_records = [];
    let bulk_load_result = undefined;
    try {
        csv_records = await alasql.promise('SELECT * FROM CSV(?, {headers:true, separator:","})', [json_message.csv_url]);
        bulk_load_result = await p_bulk_load(csv_records, json_message.schema, json_message.table, json_message.action);
    } catch(e) {
        throw new Error(e);
    }

    return bulk_load_result.message;
}

/**
 * Grab the file specified in the URL parameter.
 * @param url - URL to file.
 * @returns {Promise<*>}
 */
async function createReadStream(url) {
    let options = {
        method: 'GET',
        uri: `${url}`,
        resolveWithFullResponse: true
    };
    let response = await request_promise(options);
    if (response.statusCode !== hdb_terms.HTTP_STATUS_CODES.OK || response.headers['content-type'].indexOf('text/csv') < 0) {
        let return_object = {
            message: `CSV Load failed from URL: ${url}`,
            status_code: response.statusCode,
            status_message: response.statusMessage,
            content_type: response.headers['content-type']
        };
        return return_object;
    }
    return response;
}

/**
 * Parse and load CSV values.
 * 
 * @param json_message - An object representing the CSV file.
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @return err - any errors found during the bulk load
 *
 */
async function csvFileLoad(json_message) {
    let validation_msg = validator.fileObject(json_message);
    if (validation_msg) {
        throw new Error(validation_msg);
    }

    let csv_records = [];
    let bulk_load_result = undefined;
    try {
        csv_records = await alasql.promise('SELECT * FROM CSV(?, {headers:true, separator:","})', json_message.file_path);
        bulk_load_result = await p_bulk_load(csv_records, json_message.schema, json_message.table, json_message.action);
    } catch(e) {
        throw new Error(e);
    }

    return bulk_load_result.message;
}

/**
 * Validate all filenames of objects about to be created are valid unix filenames.  Returns true if valid, throws an exception
 * if not.
 * @param created_record - A single instance of a record created during csv load.
 * @returns {boolean} - True if valid, throws exception if not.
 */
function validateColumnNames(created_record) {
    let column_names = Object.keys(created_record);
    for(let key of column_names) {
        if(unix_filename_regex.test(key)) {
            throw new Error(`Invalid column name ${key}, cancelling load operation`);
        }
    }
    return true;
}

/**
 * Performs either a bulk insert or update depending on the action passed to the function.
 * @param records - The records to be inserted/updated
 * @param schema - The schema containing the specified table
 * @param table - The table to perform the insert/update
 * @param action - Specify either insert or update the specified records
 * @param callback - The caller
 */
function bulkLoad(records, schema, table, action, callback){
    let chunks = _.chunk(records, RECORD_BATCH_SIZE);
    let write_hashes = 0;
    //TODO: Noone remember why we have this here.  We should refactor this when
    // we have more benchmarks for comparison.  Might be able to leverage cores once
    // the process pool is ready.
    if( !action )
        action = 'insert';
    async.eachLimit(chunks, 4, (record_chunk, caller)=>{
        let target_object = {
            schema: schema,
            table: table,
            records: record_chunk
        };

        switch (action) {
            case 'insert':
                target_object.operation = 'insert';
                insert.insert(target_object, (err, data)=>{
                    if(err){
                        caller(err);
                        return;
                    }
                    if(!hdb_utils.isEmptyOrZeroLength(data.inserted_hashes)) {
                        write_hashes += data.inserted_hashes.length;
                    }

                    caller(null, data);
                });
                break;
            case 'update':
                target_object.operation = 'update';
                insert.update(target_object, (err, data)=>{
                    if(err){
                        caller(err);
                        return;
                    }
                    if(!hdb_utils.isEmptyOrZeroLength(data.update_hashes)) {
                        write_hashes += data.update_hashes.length;
                    }

                    caller(null, data);
                });
                break;
        }

    }, (err)=>{
        if(err){
            callback(err);
            return;
        }

        let update_status = {
            message: `successfully loaded ${write_hashes} of ${records.length} records`
        };
        callback(null,update_status);
    });
}