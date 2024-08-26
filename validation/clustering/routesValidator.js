'use strict';

const Joi = require('joi');
const validator = require('../validationWrapper');
const { route_constraints } = require('../configValidator');

module.exports = {
	setRoutesValidator,
	deleteRoutesValidator,
};

function setRoutesValidator(req) {
	const schema = Joi.object({
		server: Joi.valid('hub', 'leaf'),
		routes: route_constraints.required(),
	});

	return validator.validateBySchema(req, schema);
}

function deleteRoutesValidator(req) {
	const schema = Joi.object({
		routes: route_constraints.required(),
	});

	return validator.validateBySchema(req, schema);
}
