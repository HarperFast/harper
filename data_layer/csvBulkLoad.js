"use strict";

const insert = require('./insert');
const _ = require('lodash');
const validator = require('../validation/csvLoadValidator');
const request_promise = require('request-promise-native');
const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const util = require('util');
const {promise} = require('alasql');
const logger = require('../utility/logging/harper_logger');
const fs = require('fs');
const papa_parse = require('papaparse');
const fs_extra = require('fs-extra');

const NEWLINE = '\n';
const unix_filename_regex = new RegExp(/[^-_.A-Za-z0-9]/);
const ALASQL_MIDDLEWARE_PARSE_PARAMETERS = 'SELECT * FROM CSV(?, {headers:true, separator:","})';
const HIGHWATERMARK = 1024*1024*5;
hdb_utils.promisifyPapaParse();

const p_fs_access = util.promisify(fs.access);

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
async function csvDataLoad(json_message) {
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
        csv_records = await callMiddleware(ALASQL_MIDDLEWARE_PARSE_PARAMETERS, [json_message.data]);
        bulk_load_result = await callBulkLoad(csv_records, json_message.schema, json_message.table, json_message.action);
    } catch(e) {
        throw e;
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

    // check passed url to see if its live and valid data
    let url_response = undefined;
    try {
        url_response = await createReadStreamFromURL(json_message.csv_url);
    } catch (e) {
        logger.error(`invalid bulk load url ${json_message.csv_url}, response ${url_response.statusMessage}`);
        throw e;
    }
    try {
        // Some ISPs will return a "Not found" html page that still have a 200 status. This handles that.
        if(!url_response.body) {
            throw new Error(url_response.message);
        }
        csv_records = await callMiddleware(ALASQL_MIDDLEWARE_PARSE_PARAMETERS, [url_response.body]);
        bulk_load_result = await callBulkLoad(csv_records, json_message.schema, json_message.table, json_message.action);
    } catch(e) {
        throw new Error(e);
    }

    return bulk_load_result.message;
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

    try {
        // check file exists and have perms to read, throws exception if fails
        await p_fs_access(json_message.file_path, fs.constants.R_OK | fs.constants.F_OK);

        console.log(`\n\npapa parse called - memory: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);
        let bulk_load_result = await callPapaParse(json_message);
        console.log(`### papa parse finished - memory: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

        console.log(`successfully loaded ${bulk_load_result.number_written} of ${bulk_load_result.records} records`);
        return `successfully loaded ${bulk_load_result.number_written} of ${bulk_load_result.records} records`;

    } catch(err) {
        logger.error(err);
        throw err;
    }
}

async function validateChunk(json_message, results, parser) {
    if (results.data.length === 0) {
        return;
    }

    // parser pause and resume prevent the parser from getting ahead of validation.
    parser.pause();

    console.log(`validate chunk length: ${results.data.length}`);

    let write_object = {
        operation: json_message.operation,
        schema: json_message.schema,
        table: json_message.table,
        records: results.data
    };

    try {
        await insert.validation(write_object);
        parser.resume();
    } catch(err) {
        console.log(err);
        throw err;
    }
}

async function insertChunk(json_message, insert_results, results, parser) {
    if (results.data.length === 0) {
        return;
    }

    // parser pause and resume prevent the parser from getting ahead of insert.
    parser.pause();

    try {
        console.log(`insert chunk length: ${results.data.length}`);
        let bulk_load_chunk_result = await callBulkLoad(results.data, json_message.schema, json_message.table, json_message.action);
        insert_results.records += bulk_load_chunk_result.records;
        insert_results.number_written += bulk_load_chunk_result.number_written;
        parser.resume();
    } catch(err) {
        console.log(err);
        throw err;
    }

}

async function callPapaParse(json_message) {
    // passing object by reference to insert_chunk
    let insert_results = {
        records: 0,
        number_written: 0
    };

    try {
        let stream = fs_extra.createReadStream(json_message.file_path, {highWaterMark:HIGHWATERMARK});
        await papa_parse.parsePromise(stream, validateChunk.bind(null, json_message));
        console.log(`papa parse validate finished - memory: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

        stream = fs_extra.createReadStream(json_message.file_path, {highWaterMark:HIGHWATERMARK});
        await papa_parse.parsePromise(stream, insertChunk.bind(null, json_message, insert_results));
        console.log(`papa parse insert chunk finished - memory: ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100} MB`);

        return insert_results;

    } catch(err) {
        console.log(err);
        throw new Error(err);
    }
}

/**
 * Grab the file specified in the URL parameter.
 * @param {string} url - URL to file.
 * @returns {Promise<*>}
 */
async function createReadStreamFromURL(url) {
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
 * Genericize the call to the middlware used for parsing (currently alasql);
 * @param parameter_string - The parameters to be passed into the middleware
 * @param data - The data that needs to be parsed.
 * @returns {Promise<any>}
 */
async function callMiddleware(parameter_string, data) {
    if(hdb_utils.isEmptyOrZeroLength(parameter_string)) {
        logger.warn('Invalid parameter was passed into callMiddleware()');
        return [];
    }
    if(hdb_utils.isEmptyOrZeroLength(data)) {
        logger.warn('Invalid data was passed into callMiddleware()');
        return [];
    }
    let middleware_results = undefined;
    try {
        middleware_results = await promise(parameter_string, data);
        return middleware_results;
    } catch(e) {
        throw e;
    }
}

async function callBulkLoad(csv_records, schema, table, action) {
    let bulk_load_result = {};
    if(csv_records && csv_records.length > 0 && validateColumnNames(csv_records[0])) {
        bulk_load_result = await bulkLoad(csv_records, schema, table, action);
    } else {
        bulk_load_result.message = 'No records parsed from csv file.';
        logger.info(bulk_load_result.message);
    }
    return bulk_load_result;
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
 * @returns {Promise<{message: string}>}
 */
async function bulkLoad(records, schema, table, action){
    if (!action) {
        action = 'insert';
    }

    let target_object = {
        operation: action,
        schema: schema,
        table: table,
        records: records
    };


    let write_function;
    if (action === 'insert'){
        write_function = insert.insert;
    } else {
        write_function = insert.update;
    }

    try {
        let write_response = await write_function(target_object);

        let modified_hashes;
        if (action === 'insert'){
            modified_hashes = write_response.inserted_hashes;
        } else {
            modified_hashes = write_response.update_hashes;
        }

        let number_written = hdb_utils.isEmptyOrZeroLength(modified_hashes) ? 0 : modified_hashes.length;
        let update_status = {
            records: records.length,
            number_written
        };

        return update_status;
    } catch(err) {
        throw err;
    }
}
