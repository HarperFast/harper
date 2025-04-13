'use strict';

const Joi = require('joi');
const { string, array } = Joi.types();
const validator = require('../validationWrapper');
const add_update_node_validator = require('./addUpdateNodeValidator');

module.exports = configureClusterValidator;

function configureClusterValidator(req) {
	const schema = Joi.object({
		operation: string.valid('configure_cluster').required(),
		connections: array.items(add_update_node_validator.validationSchema).required(),
	});

	return validator.validateBySchema(req, schema);
}
