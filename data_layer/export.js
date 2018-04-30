"use strict";

const search = require('./search');
const sql = require('../sqlTranslator/index').evaluateSQL;
const AWS = require('aws-sdk');
const Json2csvParser = require('json2csv').Parser;
const hdb_utils = require('../utility/common_utils');

const VALID_SEARCH_OPERATIONS = ['search_by_value', 'search_by_hash', 'sql'];
const VALID_EXPORT_FORMATS = ['json', 'csv'];

module.exports = {
    export_to_s3: export_to_s3,
    export_to_local: export_to_local
};

/**
 * this is a stub for an upcoming feature
 * @param export_object
 * @param callback
 */
function export_to_local(export_object, callback) {
    callback('Coming soon...');
}

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

    operation(export_object.search_operation, function (err, results) {
        if (err) {
            return callback(err);
        }
        AWS.config.update({
            accessKeyId: export_object.s3.aws_access_key_id,
            secretAccessKey: export_object.s3.aws_secret_access_key
        });

        let fields = [];
        let s3_object;
        if (export_object.format === 'csv') {
            for (let key in results[0]) {
                fields.push(key);
            }


            let  parser = new Json2csvParser({fields});
            let csv = parser.parse(results);
            sendToS3(csv, export_object.s3.key + ".csv");
        }

        if(export_object.format === 'json'){
            s3_object = results;
            sendToS3(JSON.stringify(s3_object), export_object.s3.key + ".json");
        }






    });


}



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