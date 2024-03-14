'use strict';

const Joi = require('joi');
const validator = require('../validationWrapper');
const { validateSchemaExists, validateTableExists, validateSchemaName } = require('../common_validators');

const schema = Joi.object({
	operation: Joi.string().valid('purge_stream'),
	schema: Joi.string().custom(validateSchemaExists).custom(validateSchemaName).optional(),
	database: Joi.string().custom(validateSchemaExists).custom(validateSchemaName).optional(),
	table: Joi.string().custom(validateTableExists).required(),
});

function purgeStreamValidator(req) {
	return validator.validateBySchema(req, schema);
}

module.exports = purgeStreamValidator;
