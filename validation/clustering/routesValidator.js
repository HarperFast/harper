'use strict';

const Joi = require('joi');
const validator = require('../validationWrapper');
const { route_constraints } = require('../configValidator');

module.exports = routesValidator;

function routesValidator(req) {
	const schema = Joi.object({
		server: Joi.valid('hub', 'leaf').required(),
		routes: route_constraints.required(),
	});

	return validator.validateBySchema(req, schema);
}
