'use strict';

const Joi = require('joi');
const { string, boolean, date } = Joi.types();
const validator = require('../validationWrapper.js');
const { validateSchemaExists, validateTableExists, validateSchemaName } = require('../common_validators.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const envManager = require('../../utility/environment/environmentManager.js');
envManager.initSync();

const nodeNameConstraint = string
	.invalid(envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME) ?? 'node_name')
	.pattern(natsTerms.NATS_TERM_CONSTRAINTS_RX)
	.messages({
		'string.pattern.base': '{:#label} invalid, must not contain ., * or >',
		'any.invalid': "'node_name' cannot be this nodes name",
	})
	.empty(null);

const validationSchema = {
	operation: string.valid('add_node', 'update_node', 'set_node_replication'),
	node_name: string.optional(),
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
	return validator.validateBySchema(req, Joi.object(validationSchema));
}

/**
 * Checks that when request is addNode at least one of the subs in each sub is true
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

module.exports = { addUpdateNodeValidator, validationSchema };
