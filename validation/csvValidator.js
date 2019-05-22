'use strict';
const fs = require('fs');
const util = require('util');
const csv_load_validator = require('./csvLoadValidator');
const common_utils = require('../utility/common_utils');

const p_fs_access = util.promisify(fs.access);

// Maximum files size in bytes
const MAX_CSV_FILE_SIZE = 1000000;

module.exports = {
    csvValidator: csvValidator
};

async function csvValidator(json_body) {
    let validation_msg;
    let operation = json_body.operation;

    try {
        switch (operation) {
            case 'csv_file_load':
                validation_msg = csv_load_validator.fileObject(json_body);
                await csvFileLoadValidator(json_body);
                break;
            case 'csv_url_load':
                validation_msg = csv_load_validator.urlObject(json_body);
                break;
            default:
                validation_msg = csv_load_validator.dataObject(json_body);
        }

        if (validation_msg) {
            throw validation_msg.message;
        }

        common_utils.checkGlobalSchemaTable(json_body.schema, json_body.table);

    } catch(err) {
        throw new Error(err);
    }
}

async function csvFileLoadValidator(json_body) {
    try {
        // Checks that file has read permissions and exists in directory
        await p_fs_access(json_body.file_path, fs.constants.R_OK | fs.constants.F_OK);
    } catch(err) {
        throw err.message;
    }

    let file_size = fs.statSync(json_body.file_path).size;
    if (file_size > MAX_CSV_FILE_SIZE) {
        throw `File size is ${file_size} bytes, which exceeded the maximum size allowed of: ${MAX_CSV_FILE_SIZE} bytes`;
    }
}
