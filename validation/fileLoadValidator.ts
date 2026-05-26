import clone from 'clone';
import * as validator from './validationWrapper.ts';
import * as commonUtils from '../utility/common_utils.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as fs from 'fs';
import joi from 'joi';
const { string } = joi.types();
import { hdbErrors, handleHDBError } from '../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES } = hdbErrors;

import { commonValidators } from './common_validators.ts';

const isRequiredString = ' is required';

const actions = ['insert', 'update', 'upsert'];
const constraints = {
	database: {
		presence: false,
		format: commonValidators.schema_format,
		length: commonValidators.schema_length,
	},
	schema: {
		presence: false,
		format: commonValidators.schema_format,
		length: commonValidators.schema_length,
	},
	table: {
		presence: true,
		format: commonValidators.schema_format,
		length: commonValidators.schema_length,
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

const baseJoiSchema = {
	schema: string.required(),
	table: string.required(),
	action: string.valid('insert', 'update', 'upsert'),
};

const { AWS_ACCESS_KEY, AWS_SECRET, AWS_BUCKET, AWS_FILE_KEY, REGION } = hdbTerms.S3_BUCKET_AUTH_KEYS;

const s3Constraints = {
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

const dataConstraints = clone(constraints);
dataConstraints.data.presence = {
	message: isRequiredString,
};

const fileConstraints = clone(constraints);
fileConstraints.file_path.presence = {
	message: isRequiredString,
};

const s3FileConstraints = Object.assign(clone(constraints), s3Constraints);

const urlSchema = clone(baseJoiSchema);
urlSchema.csv_url = string.uri().messages({ 'string.uri': "'csv_url' must be a valid url" }).required();
urlSchema.passthrough_headers = joi.object();

export function dataObject(object) {
	let validateRes = validator.validateObject(object, dataConstraints);
	return postValidateChecks(object, validateRes);
}

export function urlObject(object) {
	let validateRes = validator.validateBySchema(object, joi.object(urlSchema));
	return postValidateChecks(object, validateRes);
}

export function fileObject(object) {
	let validateRes = validator.validateObject(object, fileConstraints);
	return postValidateChecks(object, validateRes);
}

export function s3FileObject(object) {
	let validateRes = validator.validateObject(object, s3FileConstraints);
	return postValidateChecks(object, validateRes);
}

/**
 * Post validate module checks, confirms schema and table exist.
 * If file upload - checks that it exists, permissions and size.
 */
function postValidateChecks(object, validateRes) {
	if (!validateRes) {
		let msg = commonUtils.checkGlobalSchemaTable(object.schema, object.table);
		if (msg) {
			return handleHDBError(new Error(), msg, HTTP_STATUS_CODES.BAD_REQUEST);
		}

		if (object.operation === hdbTerms.OPERATIONS_ENUM.CSV_FILE_LOAD) {
			try {
				fs.accessSync(object.file_path, fs.constants.R_OK | fs.constants.F_OK);
			} catch (err) {
				if (err.code === hdbTerms.NODE_ERROR_CODES.ENOENT) {
					return handleHDBError(err, `No such file or directory ${err.path}`, HTTP_STATUS_CODES.BAD_REQUEST);
				}

				if (err.code === hdbTerms.NODE_ERROR_CODES.EACCES) {
					return handleHDBError(err, `Permission denied ${err.path}`, HTTP_STATUS_CODES.BAD_REQUEST);
				}
				return handleHDBError(err);
			}
		}
	}
	return validateRes;
}
