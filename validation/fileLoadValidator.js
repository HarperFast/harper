const clone = require('clone');
const validator = require('./validationWrapper');
const common_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const log = require('../utility/logging/harper_logger');
const fs = require('fs');
const joi = require('joi');
const { string } = joi.types();
const { hdb_errors, handleHDBError } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const { common_validators } = require('./common_validators');
// Maximum file size in bytes
const MAX_FILE_SIZE = 1000000000;

const is_required_string = ' is required';

const actions = ['insert', 'update', 'upsert'];
const constraints = {
	database: {
		presence: false,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	schema: {
		presence: false,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	table: {
		presence: true,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	action: {
		inclusion: {
			within: actions,
			message: 'is required and must be either insert, update, or upsert',
		},
	},
	file_path: {},
	csv_url: {
		url: {
			allowLocal: true,
		},
	},
	data: {},
	passthrough_headers: {},
};

const base_joi_schema = {
	schema: string.required(),
	table: string.required(),
	action: string.valid('insert', 'update', 'upsert'),
};

const { AWS_ACCESS_KEY, AWS_SECRET, AWS_BUCKET, AWS_FILE_KEY, REGION } = hdb_terms.S3_BUCKET_AUTH_KEYS;

const s3_constraints = {
	s3: {
		presence: true,
	},
	[`s3.${AWS_ACCESS_KEY}`]: {
		presence: true,
		type: 'String',
	},
	[`s3.${AWS_SECRET}`]: {
		presence: true,
		type: 'String',
	},
	[`s3.${AWS_BUCKET}`]: {
		presence: true,
		type: 'String',
	},
	[`s3.${AWS_FILE_KEY}`]: {
		presence: true,
		type: 'String',
		hasValidFileExt: ['.csv', '.json'],
	},
	[`s3.${REGION}`]: {
		presence: true,
		type: 'String',
	},
};

const data_constraints = clone(constraints);
data_constraints.data.presence = {
	message: is_required_string,
};

const file_constraints = clone(constraints);
file_constraints.file_path.presence = {
	message: is_required_string,
};

const s3_file_constraints = Object.assign(clone(constraints), s3_constraints);

const url_schema = clone(base_joi_schema);
url_schema.csv_url = string.uri().messages({ 'string.uri': "'csv_url' must be a valid url" }).required();
url_schema.passthrough_headers = joi.object();

function dataObject(object) {
	let validate_res = validator.validateObject(object, data_constraints);
	return postValidateChecks(object, validate_res);
}

function urlObject(object) {
	let validate_res = validator.validateBySchema(object, joi.object(url_schema));
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
			return handleHDBError(new Error(), msg, HTTP_STATUS_CODES.BAD_REQUEST);
		}

		if (object.operation === hdb_terms.OPERATIONS_ENUM.CSV_FILE_LOAD) {
			try {
				fs.accessSync(object.file_path, fs.constants.R_OK | fs.constants.F_OK);
			} catch (err) {
				if (err.code === hdb_terms.NODE_ERROR_CODES.ENOENT) {
					return handleHDBError(err, `No such file or directory ${err.path}`, HTTP_STATUS_CODES.BAD_REQUEST);
				}

				if (err.code === hdb_terms.NODE_ERROR_CODES.EACCES) {
					return handleHDBError(err, `Permission denied ${err.path}`, HTTP_STATUS_CODES.BAD_REQUEST);
				}
				return handleHDBError(err);
			}
		}
	}
	return validate_res;
}

module.exports = {
	dataObject,
	urlObject,
	fileObject,
	s3FileObject,
};
