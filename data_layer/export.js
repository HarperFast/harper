"use strict";

const search = require('./search');
const sql = require('../sqlTranslator/index');
const AWS = require('aws-sdk');
const alasql = require('alasql');
const hdb_utils = require('../utility/common_utils');
const fs = require('fs-extra');
const path =  require('path');
const hdb_logger = require('../utility/logging/harper_logger');
const {promisify} = require('util');
const hdb_common = require('../utility/common_utils');

const VALID_SEARCH_OPERATIONS = ['search_by_value', 'search_by_hash', 'sql'];
const VALID_EXPORT_FORMATS = ['json', 'csv'];
const JSON_TEXT = 'json';
const CSV = 'csv';

// Promisified function
const p_search_by_hash = promisify(search.searchByHash);
const p_search_by_value = promisify(search.searchByValue);
const p_sql = promisify(sql.evaluateSQL);

module.exports = {
    export_to_s3: export_to_s3,
    export_local: export_local
};

/**
 * Allows for exporting and saving to a file system the receiving system has access to
 *
 * @param export_object
 */
async function export_local(export_object) {
    hdb_logger.trace(`export_local request to path: ${export_object.path}, filename: ${export_object.filename}, format: ${export_object.format}`);
    let error_message = exportCoreValidation(export_object);
    if(!hdb_utils.isEmpty(error_message)){
        hdb_logger.error(error_message);
        throw new Error(error_message);
    }

    if(hdb_utils.isEmpty(export_object.path)) {
        hdb_logger.error("path is missing");
        throw new Error("path parameter is invalid");
    }

    //we will allow for a missing filename and autogen one based on the epoch
    let filename = (hdb_utils.isEmpty(export_object.filename) ? (new Date).getTime() : export_object.filename)
        + '.' + export_object.format;

    if(export_object.path.endsWith(path.sep)){
        export_object.path = export_object.path.substring(0, export_object.path.length - 1);
    }

    let file_path = hdb_utils.buildFolderPath(export_object.path, filename);
    try {
        await confirmPath(export_object.path);
        let search_results = await searchAndConvert(export_object);
        await saveToLocal(file_path, export_object.format, search_results);
    } catch(err) {
        hdb_logger.error(err);
        throw new Error(err);
    }
}

/**
 * stats the path sent in to verify the path exists, the user has access & the path is a directory
 * @param path
 */
async function confirmPath(path) {
    hdb_logger.trace("in confirmPath");
    if(hdb_utils.isEmptyOrZeroLength(path)) {
        throw new Error(`Invalid path: ${path}`);
    }
    let stats = undefined;
    try {
        stats = await fs.stat(path);
    } catch(err) {
        let error_message;
        if (err.code === 'ENOENT') {
            error_message = `path '${path}' does not exist`;
        } else if (err.code === 'EACCES') {
            error_message = `access to path '${path}' is denied`;
        } else {
            error_message = err.message;
        }
        hdb_logger.error(error_message);
        throw new Error(error_message);
    }
    if (!stats.isDirectory()) {
        let err = `path '${path}' is not a directory, please supply a valid folder path`;
        hdb_logger.error(err);
        throw new Error(err);
    }
    return true;
}

/**
 * takes the data and saves it to the file system
 * @param file_path
 * @param source_data_format
 * @param data
 */
async function saveToLocal(file_path, source_data_format, data) {
    hdb_logger.trace("in saveToLocal");
    if(hdb_common.isEmptyOrZeroLength(file_path)) {
        throw new Error('file_path parameter is invalid.');
    }
    if(hdb_common.isEmptyOrZeroLength(source_data_format)) {
        throw new Error('Invalid source format');
    }
    if(hdb_common.isEmpty(data)) {
        throw new Error('Data not found.');
    }
    if(source_data_format === JSON_TEXT) {
        data = JSON.stringify(data);
    }
    try {
        await fs.writeFile(file_path, data);
    } catch(err) {
        hdb_logger.error(err);
        throw err;
    }
    return true;
}

/**
 *allows for exporting a result to s3
 * @param export_object
 * @returns {*}
 */
async function export_to_s3(export_object) {
    if (!export_object.s3 || Object.keys(export_object.s3).length === 0) {
        throw new Error("S3 object missing");
    }

    if (hdb_utils.isEmptyOrZeroLength(export_object.s3.aws_access_key_id)) {
        throw new Error("S3.aws_access_key_id missing");
    }

    if (hdb_utils.isEmptyOrZeroLength(export_object.s3.aws_secret_access_key)) {
        throw new Error("S3.aws_secret_access_key missing");
    }

    if (hdb_utils.isEmptyOrZeroLength(export_object.s3.bucket)) {
        throw new Error("S3.bucket missing");
    }

    if (hdb_utils.isEmptyOrZeroLength(export_object.s3.key)) {
        throw new Error("S3.key missing");
    }

    let error_message = exportCoreValidation(export_object);
    if(!hdb_utils.isEmpty(error_message)){
        throw new Error(error_message);
    }
    hdb_logger.trace(`called export_to_s3 to bucket: ${export_object.s3.bucket} and query ${export_object.search_operation.sql}`);
    let data = await searchAndConvert(export_object).catch( (err) => {
        hdb_logger.error(err);
        throw err;
    });

    AWS.config.update({
        accessKeyId: export_object.s3.aws_access_key_id,
        secretAccessKey: export_object.s3.aws_secret_access_key
    });

    let s3_data;
    let s3_name;
    if(export_object.format === CSV){
        s3_data = data;
        s3_name = export_object.s3.key + ".csv";
    } else if(export_object.format === JSON_TEXT){
        s3_data = JSON.stringify(data);
        s3_name = export_object.s3.key + ".json";
    } else {
        throw new Error("an unexpected exception has occurred, please check your request and try again.");
    }

    let s3 = new AWS.S3();
    let params = {Bucket: export_object.s3.bucket, Key: s3_name, Body: s3_data};
    let put_results = undefined;
    try {
        // The AWS API supports promises with the promise() ending.
        put_results = await s3.putObject(params).promise();
    } catch(err) {
        hdb_logger.error(err);
        throw err;
    }
    return put_results;
}

/**
 * handles the core validation of the export_object variable
 * @param export_object
 * @returns {string}
 */
function exportCoreValidation(export_object){
    hdb_logger.trace("in exportCoreValidation");
    if (hdb_utils.isEmpty(export_object.format)) {
        return "format missing";
    }

    if (VALID_EXPORT_FORMATS.indexOf(export_object.format) < 0) {
        return `format invalid. must be one of the following values: ${VALID_EXPORT_FORMATS.join(', ')}`;
    }

    let search_operation = export_object.search_operation.operation;
    if (hdb_utils.isEmpty(search_operation)) {
        return "search_operation.operation missing";
    }

    if(VALID_SEARCH_OPERATIONS.indexOf(search_operation) < 0 ){
        return `search_operation.operation must be one of the following values: ${VALID_SEARCH_OPERATIONS.join(', ')}`;
    }
}

/**
 * determines which search operation to perform, executes it then converts the data to the correct format
 * @param export_object
 */
async function searchAndConvert(export_object){
    hdb_logger.trace("in searchAndConvert");
    let operation;
    let err_msg = undefined;
    if(hdb_common.isEmpty(export_object.search_operation) || hdb_common.isEmptyOrZeroLength(export_object.search_operation.operation)) {
        throw new Error('Invalid Search operation specified');
    }
    switch (export_object.search_operation.operation) {
        case 'search_by_value':
            operation = p_search_by_value;
            break;
        case 'search_by_hash':
            operation = p_search_by_hash;
            break;
        case 'sql':
            operation = p_sql;
            break;
        default:
            err_msg = `operation ${export_object.search_operation.operation} is not support by export.`;
            hdb_logger.error(err_msg);
            throw new Error(err_msg);
    }

    //in order to validate the search function and invoke permissions we need to add the hdb_user to the search_operation
    export_object.search_operation.hdb_user = export_object.hdb_user;
    let results = undefined;
    try {
        results = await operation(export_object.search_operation);
    } catch(e) {
        hdb_logger.error(e);
        throw e;
    }
    if(export_object.format === JSON_TEXT) {
        return results;
    } else if (export_object.format === CSV) {
        let csv_results = undefined;
        try {
            csv_results = await alasql.promise('SELECT * INTO CSV({headers:true, separator:","}) FROM ?', [results]);
        } catch(e){
            hdb_logger.error(e);
            throw e;
        }
        return csv_results;
    }
}