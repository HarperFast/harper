'use strict';

const Joi = require('joi');
const { string } = Joi.types();
const hdb_terms = require('../../utility/hdbTerms');
const validator = require('../validationWrapper');

module.exports = removeRemoteSourceValidator;

function removeRemoteSourceValidator(req) {
	const schema = Joi.object({
		operation: string.valid(hdb_terms.OPERATIONS_ENUM.REMOVE_NODE).required(),
		node_name: string.required(),
	});
	return validator.validateBySchema(req, schema);
}
