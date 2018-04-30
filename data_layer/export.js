"use strict";

const search = require('./search');
const sql = require('../sqlTranslator/index').evaluateSQL;
const AWS = require('aws-sdk');
const Json2csvParser = require('json2csv').Parser;
const hdb_utils = require('../utility/common_utils');
const fs = require('graceful-fs');
const async = require('async');
const path =  require('path');

const VALID_SEARCH_OPERATIONS = ['search_by_value', 'search_by_hash', 'sql'];
const VALID_EXPORT_FORMATS = ['json', 'csv'];

module.exports = {
    export_to_s3: export_to_s3,
    export_local: export_local
};

/**
 * Allows for exporting and saving to a file system the receiving system has access to
 * @param export_object
 * @param callback
 */
function export_local(export_object, callback) {
    let error_message = exportCoreValidation(export_object);
    if(!hdb_utils.isEmpty(error_message)){
        return callback(error_message);
    }

    if(hdb_utils.isEmpty(export_object.path)){
        return callback("path is missing");
    }

    //we will allow for a missing filename and autogen one based on the epoch
    let filename = (hdb_utils.isEmpty(export_object.filename) ? (new Date).getTime() : export_object.filename)
        + '.' + export_object.format;

    if(export_object.path.endsWith(path.sep)){
        export_object.path = export_object.path.substring(0, export_object.path.length - 1);
    }

    let file_path = hdb_utils.buildFolderPath(export_object.path, filename);

    async.waterfall([
        confirmPath.bind(null, export_object.path),
        searchAndConvert.bind(null, export_object),
        saveToLocal.bind(null, file_path, export_object.format)
    ], (err)=>{
        if(err){
            return callback(err);
        }

        callback(null, `successfully exported to ${file_path}`);
    });
}

/**
 * stats the path sent in to verify the path exists, the user has access & the path is a directory
 * @param path
 * @param callback
 */
function confirmPath(path, callback){
    try {
        fs.stat(path, function statHandler(err, stat) {
            if (err) {
                let error_message;
                if (err.code === 'ENOENT') {
                    error_message = `path '${path}' does not exist`;
                } else if (err.code === 'EACCES') {
                    error_message = `access to path '${path}' is denied`;
                } else {
                    error_message = err.message;
                }

                return callback(error_message);
            }

            if (!stat.isDirectory()) {
                return callback(`path '${path}' is not a directory, please supply a valid folder path`);
            }

            return callback();
        });
    }catch(e){
        console.error(e);
    }
}

/**
 * takes the data and saves it tgo the file system
 * @param file_path
 * @param format
 * @param data
 * @param callback
 */
function saveToLocal(file_path, format, data, callback) {
    if(format === 'json'){
        data = JSON.stringify(data);
    }

    fs.writeFile(file_path, data, function fileWriteHandler(err, data){
        if(err){
            return callback(err);
        }

        return callback();
    });
}

/**
 *allows for exportinhg a result to s3
 * @param export_object
 * @param callback
 * @returns {*}
 */
function export_to_s3(export_object, callback) {
    let error_message = exportCoreValidation(export_object);

    if(!hdb_utils.isEmpty(error_message)){
        return callback(error_message);
    }

    if (hdb_utils.isEmpty(export_object.s3)) {
        return callback("S3 object missing");
    }

    if (hdb_utils.isEmpty(export_object.s3.aws_access_key_id)) {
        return callback("S3.aws_access_key_id missing");
    }

    if (hdb_utils.isEmpty(export_object.s3.aws_secret_access_key)) {
        return callback("S3.aws_secret_access_key missing");
    }

    if (hdb_utils.isEmpty(export_object.s3.bucket)) {
        return callback("S3.bucket missing");
    }

    if (hdb_utils.isEmpty(export_object.s3.key)) {
        return callback("S3.key missing");
    }

    searchAndConvert(export_object, function handleResults(err, data){
        AWS.config.update({
            accessKeyId: export_object.s3.aws_access_key_id,
            secretAccessKey: export_object.s3.aws_secret_access_key
        });

        let s3_data;
        let s3_name;
        if(export_object.format === 'csv'){
            s3_data = data;
            s3_name = export_object.s3.key + ".csv";
        } else if(export_object.format === 'json'){
            s3_data = JSON.stringify(data);
            s3_name = export_object.s3.key + ".json";
        } else {
            return callback("an unexpected exception has occurred, please check your request and try again.");
        }

        var s3 = new AWS.S3();
        let params = {Bucket: export_object.s3.bucket, Key: s3_name, Body: s3_data};
        s3.putObject(params, function (err, data) {
            if (err) {
                return callback(err);
            }

            return callback(null, data);
        });

    });
}

/**
 * handles the core validation of the export_object variable
 * @param export_object
 * @returns {string}
 */
function exportCoreValidation(export_object){
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
        return `search_operation.operation must be one of the following values: ${VALID_SEARCH_OPERATIONS.join(', ')}`
    }
}

/**
 * determines which search operation to perform, executes it then converts the data to the correct format
 * @param export_object
 * @param callback
 */
function searchAndConvert(export_object, callback){
    let operation;
    switch (export_object.search_operation.operation) {
        case 'search_by_value':
            operation = search.searchByValue;
            break;
        case 'search_by_hash':
            operation = search.searchByHash;
            break;
        case 'sql':
            operation = sql;
            break;
    }

    //in order to validate the search function and invoke permissions we need to add the hdb_user to the search_operation
    export_object.search_operation.hdb_user = export_object.hdb_user;

    operation(export_object.search_operation, function (err, results) {
        if (err) {
            return callback(err);
        }

        if(export_object.format === 'json'){
            return callback(null, results);
        } else if (export_object.format === 'csv') {
            let fields = [];
            for (let key in results[0]) {
                fields.push(key);
            }

            let  parser = new Json2csvParser({fields});
            let csv = parser.parse(results);
            return callback(null, csv);
        }
    });
}