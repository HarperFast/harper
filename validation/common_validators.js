'use strict';

const hdbUtils = require('../utility/common_utils.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const schemaRegex = /^[\x20-\x2E|\x30-\x5F|\x61-\x7E]*$/;
const Joi = require('joi');

const commonValidators = {
	schema_format: {
		pattern: schemaRegex,
		message: 'names cannot include backticks or forward slashes',
	},
	schema_length: {
		minimum: 1,
		maximum: 250,
		tooLong: 'cannot exceed 250 characters',
	},
};

// A Joi schema that can be used to validate hdb schemas and tables.
const hdbSchemaTable = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(commonValidators.schema_length.maximum)
		.pattern(schemaRegex)
		.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message }),
	Joi.number(),
	Joi.array()
).required();

const hdbDatabase = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(commonValidators.schema_length.maximum)
		.pattern(schemaRegex)
		.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message }),
	Joi.number()
);

const hdbTable = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(commonValidators.schema_length.maximum)
		.pattern(schemaRegex)
		.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message }),
	Joi.number()
).required();

function checkValidTable(propertyName, value) {
	if (!value) return `'${property_name}' is required`;
	if (typeof value !== 'string') return `'${property_name}' must be a string`;
	if (!value.length) return `'${property_name}' must be at least one character`;
	if (value.length > commonValidators.schema_length.maximum) return `'${property_name}' maximum of 250 characters`;
	if (!schemaRegex.test(value)) return `'${property_name}' has illegal characters`;
	return '';
}

function validateSchemaExists(value, helpers) {
	if (!hdbUtils.doesSchemaExist(value)) {
		return helpers.message(`Database '${value}' does not exist`);
	}

	return value;
}

function validateTableExists(value, helpers) {
	const schema = helpers.state.ancestors[0].schema;
	if (!hdbUtils.doesTableExist(schema, value)) {
		return helpers.message(`Table '${value}' does not exist`);
	}

	return value;
}

function validateSchemaName(value, helpers) {
	if (value.toLowerCase() === hdbTerms.SYSTEM_SCHEMA_NAME) {
		return helpers.message(
			`'subscriptions[${helpers.state.path[1]}]' invalid database name, '${hdb_terms.SYSTEM_SCHEMA_NAME}' name is reserved`
		);
	}

	return value;
}

module.exports = {
	commonValidators,
	schemaRegex,
	hdbSchemaTable,
	validateSchemaExists,
	validateTableExists,
	validateSchemaName,
	checkValidTable,
	hdbDatabase,
	hdbTable,
};
