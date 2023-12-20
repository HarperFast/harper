'use strict';

const hdb_utils = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const schema_regex = /^[\x20-\x2E|\x30-\x5F|\x61-\x7E]*$/;
const Joi = require('joi');

const common_validators = {
	schema_format: {
		pattern: schema_regex,
		message: 'names cannot include backticks or forward slashes',
	},
	schema_length: {
		minimum: 1,
		maximum: 250,
		tooLong: 'cannot exceed 250 characters',
	},
};

// A Joi schema that can be used to validate hdb schemas and tables.
const hdb_schema_table = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(common_validators.schema_length.maximum)
		.pattern(schema_regex)
		.messages({ 'string.pattern.base': '{:#label} ' + common_validators.schema_format.message }),
	Joi.number(),
	Joi.array()
).required();

const hdb_database = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(common_validators.schema_length.maximum)
		.pattern(schema_regex)
		.messages({ 'string.pattern.base': '{:#label} ' + common_validators.schema_format.message }),
	Joi.number()
);

const hdb_table = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(common_validators.schema_length.maximum)
		.pattern(schema_regex)
		.messages({ 'string.pattern.base': '{:#label} ' + common_validators.schema_format.message }),
	Joi.number()
).required();

function checkValidTable(property_name, value) {
	if (!value) return `'${property_name}' is required`;
	if (typeof value !== 'string') return `'${property_name}' must be a string`;
	if (!value.length) return `'${property_name}' must be at least one character`;
	if (value.length > common_validators.schema_length.maximum) return `'${property_name}' maximum of 250 characters`;
	if (!schema_regex.test(value)) return `'${property_name}' has illegal characters`;
	return '';
}
function validateSchemaExists(value, helpers) {
	if (!hdb_utils.doesSchemaExist(value)) {
		return helpers.message(`Database '${value}' does not exist`);
	}

	return value;
}

function validateTableExists(value, helpers) {
	const schema = helpers.state.ancestors[0].schema;
	if (!hdb_utils.doesTableExist(schema, value)) {
		return helpers.message(`Table '${value}' does not exist`);
	}

	return value;
}

function validateSchemaName(value, helpers) {
	if (value.toLowerCase() === hdb_terms.SYSTEM_SCHEMA_NAME) {
		return helpers.message(
			`'subscriptions[${helpers.state.path[1]}]' invalid database name, '${hdb_terms.SYSTEM_SCHEMA_NAME}' name is reserved`
		);
	}

	return value;
}

module.exports = {
	common_validators,
	schema_regex,
	hdb_schema_table,
	validateSchemaExists,
	validateTableExists,
	validateSchemaName,
	checkValidTable,
	hdb_database,
	hdb_table,
};
