const clone = require('clone');
const validator = require('./validationWrapper.js');
const common_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const log = require('../utility/logging/harper_logger');
const fs = require('fs');

// Maximum file size in bytes
const MAX_CSV_FILE_SIZE = 1000000000;

const actions = ["update", "insert"];
const constraints = {
    schema: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    table: {
        presence: true,
        format: {
            pattern: "^[a-zA-Z0-9_]*$",
            message: "must be alpha numeric"
        },
        length: {
            maximum: 250,
            tooLong: 'cannot exceed 250 characters'
        }
    },
    action: {
        inclusion: {
            within: actions,
            message: 'is required and must be either insert or update'
        }
    },
    file_path: {},
    csv_url: {
        url: {
            allowLocal: true
        }
    },
    data: {}
};

const data_constraints = clone(constraints);
data_constraints.data.presence = {
    message: " is required"
};

const file_constraints = clone(constraints);
file_constraints.file_path.presence = {
    message: " is required",
};

const url_constraints = clone(constraints);
url_constraints.csv_url.presence = {
    message: " is required"
};

function dataObject(object) {
    let validate_res = validator.validateObject(object, data_constraints);
    return postValidateChecks(object, validate_res);
}

function urlObject(object) {
    let validate_res = validator.validateObject(object, url_constraints);
    return postValidateChecks(object, validate_res);
}

function fileObject(object) {
    let validate_res = validator.validateObject(object, file_constraints);
    return postValidateChecks(object, validate_res);
}

/**
 * Post validate module checks, confirms schema and table exist.
 * If file upload - checks that it exists, permissions and size.
 */
function postValidateChecks(object, validate_res) {
    if (!validate_res) {
        let msg = common_utils.checkGlobalSchemaTable(object.schema, object.table);
        if (msg) {
            return new Error(msg);
        }

        if (object.operation === hdb_terms.OPERATIONS_ENUM.CSV_FILE_LOAD) {
            try {
                fs.accessSync(object.file_path,fs.constants.R_OK | fs.constants.F_OK);
            } catch(err) {
                return err;
            }

            try {
                let file_size = fs.statSync(object.file_path).size;
                if (file_size > MAX_CSV_FILE_SIZE) {
                    return new Error(`File size is ${file_size} bytes, which exceeded the maximum size allowed of: ${MAX_CSV_FILE_SIZE} bytes`);
                }
            } catch(err) {
                log.error(err);
                console.error(err);
            }
        }
    }
    return validate_res;
}

module.exports = {
    dataObject,
    urlObject,
    fileObject
};