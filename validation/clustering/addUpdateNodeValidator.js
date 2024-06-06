'use strict';

const Joi = require('joi');
const { string, boolean, date } = Joi.types();
const validator = require('../validationWrapper');
const { validateSchemaExists, validateTableExists, validateSchemaName } = require('../common_validators');
const hdb_terms = require('../../utility/hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const env_manager = require('../../utility/environment/environmentManager');
env_manager.initSync();

const node_name_constraint = string
	.invalid(env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) ?? 'node_name')
	.pattern(nats_terms.NATS_TERM_CONSTRAINTS_RX)
	.messages({
		'string.pattern.base': '{:#label} invalid, must not contain ., * or >',
		'any.invalid': "'node_name' cannot be this nodes name",
	})
	.empty(null)
	.required();

const validation_schema = {
	operation: string.valid('add_node', 'update_node', 'set_node_replication'),
	node_name: node_name_constraint,
	subscriptions: Joi.array().items({
		table: string.optional(),
		schema: string.optional(),
		database: string.optional(),
		subscribe: boolean.required(),
		publish: boolean.required().custom(checkForFalsy),
		start_time: date.iso(),
	}),
};

/**
 * Validates the incoming add or update node request
 * @param req
 * @returns {*}
 */
function addUpdateNodeValidator(req) {
	return validator.validateBySchema(req, Joi.object(validation_schema));
}

/**
 * Checks that when request is add_node at least one of the subs in each sub is true
 * @param value
 * @param helpers
 * @returns {*}
 */
function checkForFalsy(value, helpers) {
	if (
		helpers.state.ancestors[2].operation === 'add_node' &&
		value === false &&
		helpers.state.ancestors[0].subscribe === false
	) {
		return helpers.message(
			`'subscriptions[${helpers.state.path[1]}]' subscribe and/or publish must be set to true when adding a node`
		);
	}
}

module.exports = { addUpdateNodeValidator, validation_schema };
