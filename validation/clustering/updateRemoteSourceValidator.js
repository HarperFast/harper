'use strict';

const Joi = require('joi');
const { string, boolean, array } = Joi.types();
const hdbTerms = require('../../utility/hdbTerms.ts');
const validator = require('../validationWrapper.js');

module.exports = updateRemoteSourceValidator;

function updateRemoteSourceValidator(req) {
	const schema = Joi.object({
		operation: string.valid(hdbTerms.OPERATIONS_ENUM.ADD_NODE, hdbTerms.OPERATIONS_ENUM.UPDATE_NODE).required(),
		node_name: string.required(),
		subscriptions: array
			.items({
				schema: string.required(),
				table: string.optional(),
				hash_attribute: string.optional(),
				subscribe: boolean.required(),
				publish: boolean.required(),
			})
			.min(1)
			.required(),
	});
	return validator.validateBySchema(req, schema);
}
