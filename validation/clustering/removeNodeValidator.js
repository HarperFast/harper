'use strict';

const Joi = require('joi');
const { string } = Joi.types();
const validator = require('../validationWrapper');
const hdb_terms = require('../../utility/hdbTerms');
const env_manager = require('../../utility/environment/environmentManager');
const nats_terms = require('../../server/nats/utility/natsTerms');

module.exports = removeNodeValidator;

function removeNodeValidator(req) {
	const node_name_constraint = string
		.invalid(env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME))
		.pattern(nats_terms.NATS_TERM_CONSTRAINTS_RX)
		.messages({
			'string.pattern.base': '{:#label} invalid, must not contain ., * or >',
			'any.invalid': "'node_name' cannot be this nodes name",
		})
		.empty(null);

	const schema = Joi.object({
		operation: string.valid(hdb_terms.OPERATIONS_ENUM.REMOVE_NODE).required(),
		node_name: node_name_constraint,
	});

	return validator.validateBySchema(req, schema);
}
