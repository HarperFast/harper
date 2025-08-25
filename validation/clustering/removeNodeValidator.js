'use strict';

const Joi = require('joi');
const { string } = Joi.types();
const validator = require('../validationWrapper.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const envManager = require('../../utility/environment/environmentManager.js');
const natsTerms = require('../../server/nats/utility/natsTerms.js');

module.exports = removeNodeValidator;

function removeNodeValidator(req) {
	const nodeNameConstraint = string
		.invalid(envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME))
		.pattern(natsTerms.NATS_TERM_CONSTRAINTS_RX)
		.messages({
			'string.pattern.base': '{:#label} invalid, must not contain ., * or >',
			'any.invalid': "'node_name' cannot be this nodes name",
		})
		.empty(null);

	const schema = Joi.object({
		operation: string.valid(hdbTerms.OPERATIONS_ENUM.REMOVE_NODE).required(),
		node_name: nodeNameConstraint,
	});

	return validator.validateBySchema(req, schema);
}
