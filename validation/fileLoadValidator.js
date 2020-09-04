const clone = require('clone');
const validator = require('./validationWrapper');
const common_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const log = require('../utility/logging/harper_logger');
const fs = require('fs');
const { hdb_errors, handleHDBError } = require('../utility/errors/hdbError');
const { COMMON_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const { common_validators } = require('./common_validators');
// Maximum file size in bytes
const MAX_FILE_SIZE = 1000000000;

const actions = ["update", "insert"];
const constraints = {
    schema: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
    },
    table: {
        presence: true,
        format: common_validators.schema_format,
        length: common_validators.schema_length
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

const { AWS_ACCESS_KEY, AWS_SECRET, AWS_BUCKET, AWS_FILE_KEY } = hdb_terms.S3_BUCKET_AUTH_KEYS;

const s3_constraints = {
    s3: {
        presence: true
    },
    [`s3.${AWS_ACCESS_KEY}`]: {
        presence: true,
        type: "String"
    },
    [`s3.${AWS_SECRET}`]: {
        presence: true,
        type: "String"
    },
    [`s3.${AWS_BUCKET}`]: {
        presence: true,
        type: "String"
    },
    [`s3.${AWS_FILE_KEY}`]: {
        presence: true,
        type: "String"
    }
};

const data_constraints = clone(constraints);
data_constraints.data.presence = {
    message: " is required"
};

const file_constraints = clone(constraints);
file_constraints.file_path.presence = {
    message: " is required",
};

const s3_file_constraints = Object.assign(clone(constraints), s3_constraints);

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

function s3FileObject(object) {
    let validate_res = validator.validateObject(object, s3_file_constraints);
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
                if (err.code === hdb_terms.NODE_ERROR_CODES.ENOENT) {
                    return new Error(`No such file or directory ${err.path}`);
                }

                if (err.code === hdb_terms.NODE_ERROR_CODES.EACCES) {
                    return new Error(`Permission denied ${err.path}`);
                }
                return err;
            }

            try {
                let file_size = fs.statSync(object.file_path).size;
                if (file_size > MAX_FILE_SIZE) {
                    return handleHDBError(new Error(), COMMON_ERROR_MSGS.MAX_FILE_SIZE_ERR(file_size, MAX_FILE_SIZE), HTTP_STATUS_CODES.BAD_REQUEST);
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
    fileObject,
    s3FileObject
};
