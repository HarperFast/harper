'use strict';

const Joi = require('joi');
const { string, boolean, array } = Joi.types();
const hdb_terms = require('../../utility/hdbTerms');
const validator = require('../validationWrapper');

module.exports = updateRemoteSourceValidator;

function updateRemoteSourceValidator(req) {
	const schema = Joi.object({
		operation: string.valid(hdb_terms.OPERATIONS_ENUM.ADD_NODE, hdb_terms.OPERATIONS_ENUM.UPDATE_NODE).required(),
		node_name: string.required(),
		subscriptions: array
			.items({
				schema: string.required(),
				table: string.required(),
				hash_attribute: string.optional(),
				subscribe: boolean.required(),
				publish: boolean.required(),
			})
			.min(1)
			.required(),
	});
	return validator.validateBySchema(req, schema);
}
