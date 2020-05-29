"use strict";

const insert = require('./insert');
const validator = require('../validation/csvLoadValidator');
const request_promise = require('request-promise-native');
const hdb_terms = require('../utility/hdbTerms');
const hdb_utils = require('../utility/common_utils');
const logger = require('../utility/logging/harper_logger');
const papa_parse = require('papaparse');
const fs = require('fs-extra');
hdb_utils.promisifyPapaParse();
const env = require('../utility/environment/environmentManager');
const socket_cluster_util = require('../server/socketcluster/util/socketClusterUtils');
const transact_to_clustering_utils = require('../server/transactToClusteringUtilities');
const op_func_caller = require('../utility/OperationFunctionCaller');

const CSV_NO_RECORDS_MSG = 'No records parsed from csv file.';
const TEMP_CSV_FILE = `tempCSVURLLoad.csv`;
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
    csvFileLoad
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

        bulk_load_result = await op_func_caller.callOperationFunctionAsAwait(callBulkLoad, converted_msg, postCSVLoadFunction.bind(null, parse_results.meta.fields));

        if (bulk_load_result.message === CSV_NO_RECORDS_MSG) {
            return CSV_NO_RECORDS_MSG;
        }

        return buildCSVResponseMsg(bulk_load_result.records, bulk_load_result.number_written);
    } catch(e) {
        throw e;
    }
}

/**
 * Orchestrates a CSV data load via a file URL. First downloads the file to a temporary folder/file, then calls csvFileLoad on the
 * downloaded file. Finally deletes temporary folder and file.
 * @param json_message
 * @returns {Promise<void>}
 */
async function csvURLLoad(json_message) {
    let validation_msg = validator.urlObject(json_message);
    if (validation_msg) {
        throw new Error(validation_msg);
    }

    let csv_file_load_obj = {
        operation: hdb_terms.OPERATIONS_ENUM.CSV_FILE_LOAD,
        action: json_message.action,
        schema: json_message.schema,
        table: json_message.table,
        transact_to_cluster: json_message.transact_to_cluster,
        file_path: `${TEMP_DOWNLOAD_DIR}/${TEMP_CSV_FILE}`
    };

    try {
        await downloadCSVFile(json_message.csv_url);
    } catch (err) {
        await cleanUpTempDL();
        throw err;
    }

    try {
        let bulk_load_result = await csvFileLoad(csv_file_load_obj);
        // Remove the downloaded temporary CSV file and directory once csvFileLoad complete
        await hdb_utils.removeDir(TEMP_DOWNLOAD_DIR);

        return bulk_load_result;
    } catch (err) {
        await cleanUpTempDL();
        throw `Error loading downloaded CSV data into HarperDB: ${err}`;
    }
}

/**
 * If an error is thrown and removeDir is skipped, cleanup the temporary downloaded data.
 * @returns {Promise<void>}
 */
async function cleanUpTempDL() {
    if (fs.existsSync(TEMP_DOWNLOAD_DIR)) {
        try {
            await hdb_utils.removeDir(TEMP_DOWNLOAD_DIR);
        } catch (err) {
            logger.error(`Error removing temporary CSV URL download directory: ${err}`);
        }
    }
}

/**
 * Gets a file via URL, then creates a temporary directory in hdb root and writes file to disk.
 * @param url
 * @returns {Promise<void>}
 */
async function downloadCSVFile(url) {
    let options = {
        method: 'GET',
        uri: `${url}`,
        encoding: null,
        resolveWithFullResponse: true
    };

    let response;
    try {
        response = await request_promise(options);
    } catch(err) {
        logger.error(err);
        throw `Error downloading CSV file from ${url}, status code: ${err.statusCode}. Check the log for more information.`;
    }

    validateResponse(response, url);

    try {
        fs.mkdirSync(TEMP_DOWNLOAD_DIR);
        fs.writeFileSync(`${TEMP_DOWNLOAD_DIR}/${TEMP_CSV_FILE}`, response.body);
    } catch(err) {
        logger.error(`Error writing temporary CSV file to storage`);
        throw err;
    }
}

/**
 * Runs multiple validations on response from HTTP client.
 * @param response
 * @param url
 */
function validateResponse(response, url) {
    if (response.statusCode !== hdb_terms.HTTP_STATUS_CODES.OK) {
        throw new Error(`CSV Load failed from URL: ${url}, status code: ${response.statusCode}, message: ${response.statusMessage}`);
    }

    if (!ACCEPTABLE_URL_CONTENT_TYPE_ENUM[response.headers['content-type']]) {
        throw new Error(`CSV Load failed from URL: ${url}, unsupported content type: ${response.headers['content-type']}`);
    }

    if (!response.body) {
        throw new Error(`CSV Load failed from URL: ${url}, no csv found at url`);
    }
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
        let bulk_load_result = await callPapaParse(json_message);

        return buildCSVResponseMsg(bulk_load_result.records, bulk_load_result.number_written);
    } catch(err) {
        logger.error(err);
        throw err;
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
    if (results.data.length === 0) {
        return;
    }

    // parser pause and resume prevent the parser from getting ahead of validation.
    parser.pause();

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
        logger.error(err);
        // reject is a promise object bound to chunk function through hdb_utils.promisifyPapaParse(). In the case of an error
        // reject will bubble up to hdb_utils.promisifyPapaParse() and return a reject promise object with given error.
        reject(err);
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
    if (results.data.length === 0) {
        return;
    }

    // parser pause and resume prevent the parser from getting ahead of insert.
    parser.pause();

    let fields = results.meta.fields;

    results.data.forEach(record=>{
        if(!hdb_utils.isEmpty(record) && !hdb_utils.isEmpty(record['__parsed_extra'])){
            delete record['__parsed_extra'];
        }
    });

    try {
        let converted_msg = {
            schema: json_message.schema,
            table: json_message.table,
            action: json_message.action,
            transact_to_cluster: json_message.transact_to_cluster,
            data: results.data
        };
        let bulk_load_chunk_result = await op_func_caller.callOperationFunctionAsAwait(callBulkLoad, converted_msg, postCSVLoadFunction.bind(null, fields));
        insert_results.records += bulk_load_chunk_result.records;
        insert_results.number_written += bulk_load_chunk_result.number_written;
        parser.resume();
    } catch(err) {
        logger.error(err);
        // reject is a promise object bound to chunk function through hdb_utils.promisifyPapaParse(). In the case of an error
        // reject will bubble up to hdb_utils.promisifyPapaParse() and return a reject promise object with given error.
        reject(err);
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
        logger.error(err);
        throw err;
    }
}

async function callBulkLoad(json_msg) {
    let bulk_load_result = {};
    try {
        if (json_msg.data && json_msg.data.length > 0 && validateColumnNames(json_msg.data[0])) {
            bulk_load_result = await bulkLoad(json_msg.data, json_msg.schema, json_msg.table, json_msg.action);
        } else {
            bulk_load_result.message = 'No records parsed from csv file.';
            logger.info(bulk_load_result.message);
        }
    } catch(err) {
        logger.error(err);
        throw err;
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
        throw err;
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
 * Builds the response message returned by CSV operations.
 * @param total_records
 * @param number_written
 */
function buildCSVResponseMsg(total_records, number_written) {
    return `successfully loaded ${number_written} of ${total_records} records`;
}
