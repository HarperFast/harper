'use strict';

import * as hdbUtils from '../utility/common_utils.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
export const schemaRegex = /^[\x20-\x2E|\x30-\x5F|\x61-\x7E]*$/;
import Joi from 'joi';

export const commonValidators = {
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
export const hdbSchemaTable = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(commonValidators.schema_length.maximum)
		.pattern(schemaRegex)
		.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message }),
	Joi.number(),
	Joi.array()
).required();

export const hdbDatabase = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(commonValidators.schema_length.maximum)
		.pattern(schemaRegex)
		.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message }),
	Joi.number()
);

export const hdbTable = Joi.alternatives(
	Joi.string()
		.min(1)
		.max(commonValidators.schema_length.maximum)
		.pattern(schemaRegex)
		.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message }),
	Joi.number()
).required();

export function checkValidTable(propertyName, value) {
	if (!value) return `'${propertyName}' is required`;
	if (typeof value !== 'string') return `'${propertyName}' must be a string`;
	if (!value.length) return `'${propertyName}' must be at least one character`;
	if (value.length > commonValidators.schema_length.maximum) return `'${propertyName}' maximum of 250 characters`;
	if (!schemaRegex.test(value)) return `'${propertyName}' has illegal characters`;
	return '';
}

export function validateSchemaExists(value, helpers) {
	if (!hdbUtils.doesSchemaExist(value)) {
		return helpers.message(`Database '${value}' does not exist`);
	}

	return value;
}

export function validateTableExists(value, helpers) {
	const schema = helpers.state.ancestors[0].schema;
	if (!hdbUtils.doesTableExist(schema, value)) {
		return helpers.message(`Table '${value}' does not exist`);
	}

	return value;
}

export function validateSchemaName(value, helpers) {
	if (value.toLowerCase() === hdbTerms.SYSTEM_SCHEMA_NAME) {
		return helpers.message(
			`'subscriptions[${helpers.state.path[1]}]' invalid database name, '${hdbTerms.SYSTEM_SCHEMA_NAME}' name is reserved`
		);
	}

	return value;
}
