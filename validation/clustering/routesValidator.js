'use strict';

const Joi = require('joi');
const validator = require('../validationWrapper.js');
const { routeConstraints } = require('../configValidator.js');

module.exports = {
	setRoutesValidator,
	deleteRoutesValidator,
};

function setRoutesValidator(req) {
	const schema = Joi.object({
		server: Joi.valid('hub', 'leaf'),
		routes: routeConstraints.required(),
	});

	return validator.validateBySchema(req, schema);
}

function deleteRoutesValidator(req) {
	const schema = Joi.object({
		routes: routeConstraints.required(),
	});

	return validator.validateBySchema(req, schema);
}
