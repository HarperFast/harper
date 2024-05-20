'use strict';

const Joi = require('joi');
const validator = require('./validationWrapper');

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
	const schema = Joi.object({
		schema: Joi.string(),
		database: Joi.string(),
		table: Joi.string().required(),
		timestamp: Joi.date().timestamp().required(),
	});

	return validator.validateBySchema(req, schema);
}
