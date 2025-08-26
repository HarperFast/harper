'use strict';

const Joi = require('joi');
const { string } = Joi.types();
const hdbTerms = require('../../utility/hdbTerms.ts');
const validator = require('../validationWrapper.js');

module.exports = removeRemoteSourceValidator;

function removeRemoteSourceValidator(req) {
	const schema = Joi.object({
		operation: string.valid(hdbTerms.OPERATIONS_ENUM.REMOVE_NODE).required(),
		node_name: string.required(),
	});
	return validator.validateBySchema(req, schema);
}
