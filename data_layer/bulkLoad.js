"use strict";

const insert = require('./insert');
const validator = require('../validation/fileLoadValidator');
const request_promise = require('request-promise-native');
const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const { handleHDBError, handleValidationError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, COMMON_ERROR_MSGS, CHECK_LOGS_WRAPPER } = hdb_errors;
const logger = require('../utility/logging/harper_logger');
const papa_parse = require('papaparse');
const fs = require('fs-extra');
const path = require('path');
hdb_utils.promisifyPapaParse();
const env = require('../utility/environment/environmentManager');
const socket_cluster_util = require('../server/socketcluster/util/socketClusterUtils');
const transact_to_clustering_utils = require('../server/transactToClusteringUtilities');
const op_func_caller = require('../utility/OperationFunctionCaller');
const AWSConnector = require('../utility/AWS/AWSConnector');

const CSV_NO_RECORDS_MSG = 'No records parsed from csv file.';

const TEMP_DOWNLOAD_DIR = `${env.get('HDB_ROOT')}/tmp`;
const { schema_regex } = require('../validation/common_validators');
const HIGHWATERMARK = 1024*1024*5;
const ACCEPTABLE_URL_CONTENT_TYPE_ENUM = {
    'text/csv': true,
    'application/octet-stream': true,
    'text/plain': true,
    'application/vnd.ms-excel': true
};

module.exports = {
    csvDataLoad,
    csvURLLoad,
    csvFileLoad,
    importFromS3
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
        throw handleValidationError(validation_msg, validation_msg.message);
    }

    let bulk_load_result = {};
    try {
        let converted_msg = {
            schema: json_message.schema,
            table: json_message.table,
            action: json_message.action,
            transact_to_cluster: json_message.transact_to_cluster,
            data: []
        };

        let parse_results = papa_parse.parse(json_message.data,
            {
                header: true,
                skipEmptyLines: true,
                dynamicTyping: true
            });

        converted_msg.data = parse_results.data;

        bulk_load_result = await op_func_caller.callOperationFunctionAsAwait(callBulkFileLoad, converted_msg, postCSVLoadFunction.bind(null, parse_results.meta.fields));

        if (bulk_load_result.message === CSV_NO_RECORDS_MSG) {
            return CSV_NO_RECORDS_MSG;
        }

        return buildResponseMsg(bulk_load_result.records, bulk_load_result.number_written);
    } catch(err) {
        throw buildTopLevelErrMsg(err);
    }
}

/**
 * Orchestrates a CSV data load via a file URL. First downloads the file to a temporary folder/file, then calls fileLoad on the
 * downloaded file. Finally deletes temporary file.
 * @param json_message
 * @returns {Promise<string>}
 */
async function csvURLLoad(json_message) {
    let validation_msg = validator.urlObject(json_message);
    if (validation_msg) {
        throw handleValidationError(validation_msg, validation_msg.message);
    }

    let csv_file_name = `${Date.now()}.csv`;

    let csv_file_load_obj = {
        action: json_message.action,
        schema: json_message.schema,
        table: json_message.table,
        transact_to_cluster: json_message.transact_to_cluster,
        file_path: `${TEMP_DOWNLOAD_DIR}/${csv_file_name}`,
        file_type: '.csv'
    };

    try {
        await downloadCSVFile(json_message.csv_url, csv_file_name);
    } catch (err) {
        logger.error(COMMON_ERROR_MSGS.DOWNLOAD_FILE_ERR(csv_file_name) + ' - ' + err);
        throw handleHDBError(err, CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.DOWNLOAD_FILE_ERR(csv_file_name)));
    }

    try {
        let bulk_load_result = await fileLoad(csv_file_load_obj);

        // Remove the downloaded temporary CSV file and directory once fileLoad complete
        try {
            await fs.access(csv_file_load_obj.file_path);
            await fs.unlink(csv_file_load_obj.file_path);
        }catch(e){
            logger.warn(`could not delete temp csv file ${csv_file_load_obj.file_path}, file does not exist`);
        }
        return bulk_load_result;
    } catch (err) {
        throw buildTopLevelErrMsg(err);
    }
}

/**
 * This is the top-level API method to handle the local csv file load operation.
 *
 * @param json_message
 * @returns {Promise<string>}
 */
async function csvFileLoad(json_message) {
    let validation_msg = validator.fileObject(json_message);
    if (validation_msg) {
        throw handleValidationError(validation_msg, validation_msg.message);
    }

    json_message.file_type = ".csv";

    try {
        let bulk_load_result = await fileLoad(json_message);

        return bulk_load_result;
    } catch (err) {
        throw buildTopLevelErrMsg(err);
    }
}

/**
 * This is the top-level API method that handles CSV and JSON file imports from private S3 buckets.  First downloads
 * the file to a temporary folder/file, then calls fileLoad on the downloaded file. Finally deletes temporary file.
 *
 * @param json_message
 * @returns {Promise<string>}
 */
async function importFromS3(json_message) {
    let validation_msg = validator.s3FileObject(json_message);
    if (validation_msg) {
        throw handleValidationError(validation_msg, validation_msg.message);
    }

    try {
        let s3_file_type = path.extname(json_message.s3.key);
        let s3_file_name = `${Date.now()}${s3_file_type}`;

        let s3_file_load_obj = {
            action: json_message.action,
            schema: json_message.schema,
            table: json_message.table,
            transact_to_cluster: json_message.transact_to_cluster,
            file_path: `${TEMP_DOWNLOAD_DIR}/${s3_file_name}`,
            file_type: s3_file_type
        };

        await downloadFileFromS3(s3_file_name, json_message);

        let bulk_load_result = await fileLoad(s3_file_load_obj);

        // Remove the downloaded temporary CSV file and directory once fileLoad complete
        try {
            await fs.access(s3_file_load_obj.file_path);
            await fs.unlink(s3_file_load_obj.file_path);
        } catch(e){
            logger.warn(`could not delete temp csv file ${s3_file_load_obj.file_path}, file does not exist`);
        }
        return bulk_load_result;
    } catch (err) {
        throw buildTopLevelErrMsg(err);
    }
}

/**
 * Gets a file via URL, then creates a temporary directory in hdb root and writes file to disk.
 * @param url
 * @param csv_file_name
 * @returns {Promise<void>}
 */
async function downloadCSVFile(url, csv_file_name) {
    let options = {
        method: 'GET',
        uri: `${url}`,
        encoding: null,
        resolveWithFullResponse: true
    };

    let response;
    try {
        //TODO - 'request_promise' has been deprecated.  We should consider updating this library if we ever need to use
        // this functionality in other areas in CORE.  See CORE-1127
        response = await request_promise(options);
    } catch(err) {
        const err_msg = `Error downloading CSV file from ${url}, status code: ${err.statusCode}. Check the log for more information.`;
        throw handleHDBError(err, err_msg, err.statusCode, logger.ERR, "Error downloading CSV file - " + err);
    }

    validateURLResponse(response, url);

    await writeFileToTempFolder(csv_file_name, response.body);
}

/**
 * Used to create the read stream from the S3 bucket to pipe into a local write stream.
 * @param s3_file_name - file name used to save the downloaded file locally in the tmp file
 * @param json_message
 * @returns {Promise<void>}
 */
async function downloadFileFromS3(s3_file_name, json_message) {
    try {
        const tempDownloadLocation = `${TEMP_DOWNLOAD_DIR}/${s3_file_name}`;
        await fs.mkdirp(TEMP_DOWNLOAD_DIR);
        await fs.writeFile(`${TEMP_DOWNLOAD_DIR}/${s3_file_name}`, "", { flag: 'a+' });
        let tempFileStream = await fs.createWriteStream(tempDownloadLocation);
        let s3Stream = AWSConnector.getFileStreamFromS3(json_message);

        await new Promise((resolve, reject) => {
            s3Stream.on('error', function(err) {
                reject(err);
            });

            s3Stream.pipe(tempFileStream)
                .on('error', function(err) {
                    reject(err);
                })
                .on('close', function() {
                    logger.info(`${json_message.s3.key} successfully downloaded to ${tempDownloadLocation}`);
                    resolve();
                });
        });
    } catch(err) {
        logger.error(COMMON_ERROR_MSGS.S3_DOWNLOAD_ERR + " - " + err);
        throw handleHDBError(err, CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.S3_DOWNLOAD_ERR));
    }
}

/**
 * Used to write the CSV data in the body.data from an http request to the local tmp file for processing
 *
 * @param file_name - file name used to save the downloaded file locally in the tmp file
 * @param response_body - body.data value in response from http request
 * @returns {Promise<void>}
 */
async function writeFileToTempFolder(file_name, response_body) {
    try {
        await fs.mkdirp(TEMP_DOWNLOAD_DIR);
        await fs.writeFile(`${TEMP_DOWNLOAD_DIR}/${file_name}`, response_body);
    } catch(err) {
        logger.error(COMMON_ERROR_MSGS.WRITE_TEMP_FILE_ERR);
        throw handleHDBError(err, CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR));
    }
}

/**
 * Runs multiple validations on response from HTTP client.
 * @param response
 * @param url
 */
function validateURLResponse(response, url) {
    if (response.statusCode !== hdb_errors.HTTP_STATUS_CODES.OK) {
        throw handleHDBError(new Error(),`CSV Load failed from URL: ${url}, status code: ${response.statusCode}, message: ${response.statusMessage}`, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if (!ACCEPTABLE_URL_CONTENT_TYPE_ENUM[response.headers['content-type']]) {
        throw handleHDBError(new Error(),`CSV Load failed from URL: ${url}, unsupported content type: ${response.headers['content-type']}`, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if (!response.body) {
        throw handleHDBError(new Error(),`CSV Load failed from URL: ${url}, no csv found at url`, HTTP_STATUS_CODES.BAD_REQUEST);
    }
}

/**
 * Parse and load CSV or JSON values.
 *
 * @param json_message - An object representing the CSV file.
 * @returns validation_msg - Contains any validation errors found
 * @returns error - any errors found reading the csv file
 * @return err - any errors found during the bulk load
 *
 */
async function fileLoad(json_message) {
    try {
        let bulk_load_result;

        switch (json_message.file_type) {
            case hdb_terms.VALID_S3_FILE_TYPES.CSV:
                bulk_load_result = await callPapaParse(json_message);
                break;
            case hdb_terms.VALID_S3_FILE_TYPES.JSON:
                bulk_load_result = await insertJson(json_message);
                break;
            default:
                //we should never get here but here just incase something changes is validation and slips through
                throw handleHDBError(
                    new Error(),
                    COMMON_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR,
                    HTTP_STATUS_CODES.BAD_REQUEST,
                    logger.ERR,
                    COMMON_ERROR_MSGS.INVALID_FILE_EXT_ERR(json_message)
                );
        }

        return buildResponseMsg(bulk_load_result.records, bulk_load_result.number_written);
    } catch(err) {
        throw buildTopLevelErrMsg(err);
    }
}

/**
 * Passed to papaparse to validate chunks of csv data from a read stream.
 *
 * @param json_message - An object representing the CSV file.
 * @param reject - A promise object bound to function through hdb_utils.promisifyPapaParse()
 * @param results - An object returned by papaparse containing parsed csv data, errors and meta.
 * @param parser - An  object returned by papaparse contains abort, pause and resume.
 * @returns if validation error found returns Promise<error>, if no error nothing is returned.
 */
async function validateChunk(json_message, reject, results, parser) {
    const results_data = results.data ? results.data : results;
    if (results_data.length === 0) {
        return;
    }

    // parser pause and resume prevent the parser from getting ahead of validation.
    if (parser) {
        parser.pause();
    }
    let write_object = {
        operation: json_message.operation,
        schema: json_message.schema,
        table: json_message.table,
        records: results_data
    };

    try {
        await insert.validation(write_object);
        if (parser) {
            parser.resume();
        }
    } catch(err) {
        // reject is a promise object bound to chunk function through hdb_utils.promisifyPapaParse(). In the case of an error
        // reject will bubble up to hdb_utils.promisifyPapaParse() and return a reject promise object with given error.
        const err_resp = handleValidationError(err, err);
        reject(err_resp);
    }
}

/**
 * Passed to papaparse to insert chunks of csv data from a read stream.
 *
 * @param json_message - An object representing the CSV file.
 * @param insert_results - An object passed by reference used to accumulate results from insert or update function.
 * @param reject - A promise object bound to function through hdb_utils.promisifyPapaParse().
 * @param results - An object returned by papaparse containing parsed csv data, errors and meta.
 * @param parser - An  object returned by papaparse contains abort, pause and resume.
 * @returns if validation error found returns Promise<error>, if no error nothing is returned.
 */
async function insertChunk(json_message, insert_results, reject, results, parser) {
    const results_data = results.data ? results.data : results;
    if (results_data.length === 0) {
        return;
    }

    // parser pause and resume prevent the parser from getting ahead of insert.
    if (parser) {
        parser.pause();
    }

    let fields = results.meta ? results.meta.fields : null;

    if (fields) {
        results_data.forEach(record=>{
            if(!hdb_utils.isEmpty(record) && !hdb_utils.isEmpty(record['__parsed_extra'])){
                delete record['__parsed_extra'];
            }
        });
    } else {
        const fields_set = new Set();
        results_data.forEach(record => {
            Object.keys(record).forEach(key => fields_set.add(key));
        });
        fields = [...fields_set];
    }

    try {
        let converted_msg = {
            schema: json_message.schema,
            table: json_message.table,
            action: json_message.action,
            transact_to_cluster: json_message.transact_to_cluster,
            data: results_data
        };
        let bulk_load_chunk_result = await op_func_caller.callOperationFunctionAsAwait(callBulkFileLoad, converted_msg,
            postCSVLoadFunction.bind(null, fields));
        insert_results.records += bulk_load_chunk_result.records;
        insert_results.number_written += bulk_load_chunk_result.number_written;
        if (parser) {
            parser.resume();
        }
    } catch(err) {
        // reject is a promise object bound to chunk function through hdb_utils.promisifyPapaParse(). In the case of an error
        // reject will bubble up to hdb_utils.promisifyPapaParse() and return a reject promise object with given error.
        const err_resp = handleHDBError(err, CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.INSERT_CSV_ERR),
            HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, logger.ERR, COMMON_ERROR_MSGS.INSERT_CSV_ERR + ' - ' + err);
        reject(err_resp);
    }
}


/**
 * Handles two asynchronous calls to csv parser papaparse.
 * First call validates the full read stream from csv file by calling papaparse with validateChunk function. The entire
 * stream is consumed by validate because all rows must be validated before calling insert.
 * Second call inserts a new csv file read stream by calling papaparse with insertChunk function.
 *
 * @param json_message - An object representing the CSV file.
 * @returns {Promise<{records: number, number_written: number}>}
 */
async function callPapaParse(json_message) {
    // passing insert_results object by reference to insertChunk function where it accumulate values from bulk load results.
    let insert_results = {
        records: 0,
        number_written: 0
    };

    try {
        let stream = fs.createReadStream(json_message.file_path, {highWaterMark:HIGHWATERMARK});
        stream.setEncoding('utf8');
        await papa_parse.parsePromise(stream, validateChunk.bind(null, json_message));

        stream = fs.createReadStream(json_message.file_path, {highWaterMark:HIGHWATERMARK});
        stream.setEncoding('utf8');
        await papa_parse.parsePromise(stream, insertChunk.bind(null, json_message, insert_results));
        stream.destroy();

        return insert_results;
    } catch(err) {
        throw handleHDBError(err, CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.PAPA_PARSE_ERR), HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, logger.ERR, COMMON_ERROR_MSGS.PAPA_PARSE_ERR + err);
    }
}

async function insertJson(json_message) {
    // passing insert_results object by reference to insertChunk function where it accumulate values from bulk load results.
    let insert_results = {
        records: 0,
        number_written: 0
    };

    try {
        let stream = fs.createReadStream(json_message.file_path, {highWaterMark:HIGHWATERMARK});
        stream.setEncoding('utf8');
        await new Promise((resolve, reject) => {
            stream.on('error', function(err) {
                reject(err);
            });
            stream.on('data', async (chunk) => {
                await validateChunk(json_message, reject, JSON.parse(chunk), stream);
            });
            stream.on('end',  () => {
                resolve();
            });
        });

        stream = fs.createReadStream(json_message.file_path, {highWaterMark:HIGHWATERMARK});
        stream.setEncoding('utf8');
        await new Promise((resolve, reject) => {
            stream.on('error', function(err) {
                reject(err);
            });
            stream.on('data', async (chunk) => {
                await insertChunk(json_message, insert_results, reject, JSON.parse(chunk), stream);
            });
            stream.on('end',  () => {
                resolve();
            });
        });
        stream.destroy();

        return insert_results;
    } catch(err) {
        throw handleHDBError(err, CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.INSERT_JSON_ERR), HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, logger.ERR, COMMON_ERROR_MSGS.INSERT_JSON_ERR + err);
    }
}

async function callBulkFileLoad(json_msg) {
    let bulk_load_result = {};
    try {
        if (json_msg.data && json_msg.data.length > 0 && validateColumnNames(json_msg.data[0])) {
            bulk_load_result = await bulkFileLoad(json_msg.data, json_msg.schema, json_msg.table, json_msg.action);
        } else {
            bulk_load_result.message = 'No records parsed from csv file.';
            logger.info(bulk_load_result.message);
        }
    } catch(err) {
        throw buildTopLevelErrMsg(err);
    }
    return bulk_load_result;
}

/**
 * Validate all attribute names about to be created are valid.  Returns true if valid, throws an exception
 * if not.
 * @param created_record - A single instance of a record created during csv load.
 * @returns {boolean} - True if valid, throws exception if not.
 */
function validateColumnNames(created_record) {
    let column_names = Object.keys(created_record);
    for(let key of column_names) {
        if(!schema_regex.test(key)) {
            throw new Error(`Invalid column name '${key}', cancelling load operation`);
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
 * @returns {Promise<{records: *, new_attributes: *, number_written: number}>}
 */
async function bulkFileLoad(records, schema, table, action){
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

        if(Array.isArray(write_response.skipped_hashes) && write_response.skipped_hashes.length > 0){
            let table_info = global.hdb_schema[schema][table];
            let hash_attribute = table_info.hash_attribute;

            let x = records.length;
            while(x--){
                if(write_response.skipped_hashes.indexOf(records[x][hash_attribute]) >= 0){
                    records.splice(x, 1);
                }
            }
        }

        let number_written = hdb_utils.isEmptyOrZeroLength(modified_hashes) ? 0 : modified_hashes.length;
        let update_status = {
            records: records.length,
            number_written,
            new_attributes: write_response.new_attributes
        };

        return update_status;
    } catch(err) {
        throw buildTopLevelErrMsg(err);
    }
}

async function postCSVLoadFunction(fields, orig_bulk_msg, result, orig_req) {
    let transaction_msg = hdb_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
    transaction_msg.__transacted = true;

    if(!orig_bulk_msg.transact_to_cluster) {
        transact_to_clustering_utils.sendAttributeTransaction(result, orig_bulk_msg, transaction_msg, orig_req);
        delete result.new_attributes;
        return result;
    }

    if(orig_bulk_msg.data.length === 0){
        return;
    }

    let unparse_results = papa_parse.unparse(orig_bulk_msg.data,
        {
            header:true,
            skipEmptyLines: true,
            columns: fields
        });

    transaction_msg.transaction = {
        operation: "csv_data_load",
        action: orig_bulk_msg.action ? orig_bulk_msg.action : 'insert',
        schema: orig_bulk_msg.schema,
        table: orig_bulk_msg.table,
        transact_to_cluster: orig_bulk_msg.transact_to_cluster,
        data: unparse_results
    };
    if (orig_req) {
        socket_cluster_util.concatSourceMessageHeader(transaction_msg, orig_req);
    }
    hdb_utils.sendTransactionToSocketCluster(`${orig_bulk_msg.schema}:${orig_bulk_msg.table}`, transaction_msg, env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));

    transact_to_clustering_utils.sendAttributeTransaction(result, orig_bulk_msg, transaction_msg, orig_req);
    delete result.new_attributes;
}

/**
 * Builds the response message returned by bulk load operations.
 * @param total_records
 * @param number_written
 */
function buildResponseMsg(total_records, number_written) {
    return `successfully loaded ${number_written} of ${total_records} records`;
}

/**
 * Uses handleHDBError here to ensure the specific error that has already been created when thrown lower down
 * the stack is used OR, if it hasn't been handled yet, will create and return the generic error message for bulk load
 * and log the error
 *
 * @param err - error caught to be turned into a HDBError (if not already) or passed through via HDBError
 * @returns {HdbError}
 */
function buildTopLevelErrMsg(err) {
    return handleHDBError(
        err,
        CHECK_LOGS_WRAPPER(COMMON_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR),
        HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
        logger.ERR,
        COMMON_ERROR_MSGS.DEFAULT_BULK_LOAD_ERR + ' - ' + err
    );
}
