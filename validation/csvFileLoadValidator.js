'use strict';
const fs = require('fs');
const util = require('util');
const csv_validator = require('./csvLoadValidator');

// Maximum files size in bytes
const MAX_CSV_FILE_SIZE = 1000000;

const p_fs_access = util.promisify(fs.access);

module.exports = {
    csvFileLoadValidator: csvFileLoadValidator
};

async function csvFileLoadValidator(json_message) {
    let validation_msg = csv_validator.fileObject(json_message);
    if (validation_msg) {
        throw new Error(validation_msg.message);
    }

    try {
        // Checks that file is readable and exists in directory
        await p_fs_access(json_message.file_path, fs.constants.R_OK | fs.constants.F_OK);
    } catch(err) {
        throw err.message;
    }

    let file_size = fs.statSync(json_message.file_path).size;
    if (file_size > MAX_CSV_FILE_SIZE) {
        throw new Error(`File size is ${file_size} bytes, which exceeded the maximum size allowed of: ${MAX_CSV_FILE_SIZE} bytes`);
    }
}
