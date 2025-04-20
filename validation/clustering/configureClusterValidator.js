'use strict';

const Joi = require('joi');
const { string, array } = Joi.types();
const validator = require('../validationWrapper.js');
const addUpdateNodeValidator = require('./addUpdateNodeValidator.js');

module.exports = configureClusterValidator;

function configureClusterValidator(req) {
	const schema = Joi.object({
		operation: string.valid('configure_cluster').required(),
		connections: array.items(addUpdateNodeValidator.validationSchema).required(),
	});

	return validator.validateBySchema(req, schema);
}
