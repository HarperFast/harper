'use strict';

import Joi from 'joi';
import * as validator from './validationWrapper.js';

export {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
};

function readTransactionLogValidator(req: any): Error | undefined {
	const schema = Joi.object({
		schema: Joi.string(),
		database: Joi.string(),
		table: Joi.string().required(),
		from: Joi.date().timestamp(),
		to: Joi.date().timestamp(),
		limit: Joi.number().min(1),
	});

	return validator.validateBySchema(req, schema);
}

function deleteTransactionLogsBeforeValidator(req: any): Joi.ValidationResult {
	// `table` will need to be required for lmdb, but not for rocksdb
	const schema = Joi.object({
		schema: Joi.string(),
		database: Joi.string(),
		table: Joi.string(),
		timestamp: Joi.date().timestamp().required(),
	}).or('schema', 'database');

	return schema.validate(req, { allowUnknown: true, abortEarly: false, errors: { wrap: { label: "'" } } });
}
