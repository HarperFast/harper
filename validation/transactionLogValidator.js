'use strict';

const Joi = require('joi');
const validator = require('./validationWrapper.js');

module.exports = {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
};

function readTransactionLogValidator(req) {
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

function deleteTransactionLogsBeforeValidator(req) {
	// `table` will need to be required for lmdb, but not for rocksdb
	const schema = Joi.object({
		schema: Joi.string(),
		database: Joi.string(),
		table: Joi.string(),
		timestamp: Joi.date().timestamp().required(),
	}).or('schema', 'database');

	return schema.validate(req, { allowUnknown: true, abortEarly: false, errors: { wrap: { label: "'" } } });
}
