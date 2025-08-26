const _ = require('lodash'),
	validator = require('./validationWrapper.js');
const Joi = require('joi');
const hdbUtils = require('../utility/common_utils.js');
const { hdbSchemaTable, checkValidTable, hdbTable, hdbDatabase } = require('./common_validators.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { getDatabases } = require('../resources/databases.ts');
const { HTTP_STATUS_CODES } = hdbErrors;

const searchByValueSchema = Joi.object({
	database: hdbDatabase,
	schema: hdbDatabase,
	table: hdbTable,
	search_attribute: hdbSchemaTable,
	search_value: Joi.any().required(),
	get_attributes: Joi.array().min(1).items(Joi.alternatives(hdbSchemaTable, Joi.object())).optional(),
	desc: Joi.bool(),
	limit: Joi.number().integer().min(1),
	offset: Joi.number().integer().min(0),
});

const searchByConditionsSchema = Joi.object({
	database: hdbDatabase,
	schema: hdbDatabase,
	table: hdbTable,
	operator: Joi.string().valid('and', 'or').default('and').lowercase(),
	offset: Joi.number().integer().min(0),
	limit: Joi.number().integer().min(1),
	get_attributes: Joi.array().min(1).items(Joi.alternatives(hdbSchemaTable, Joi.object())).optional(),
	sort: Joi.object({
		attribute: Joi.alternatives(hdbSchemaTable, Joi.array().min(1)),
		descending: Joi.bool().optional(),
	}).optional(),
	conditions: Joi.array()
		.min(1)
		.items(
			Joi.alternatives(
				Joi.object({ operator: Joi.string().valid('and', 'or').default('and').lowercase(), conditions: Joi.array() }),
				Joi.object({
					search_attribute: Joi.alternatives(hdbSchemaTable, Joi.array().min(1)),
					search_type: Joi.string()
						.valid(
							'equals',
							'contains',
							'starts_with',
							'ends_with',
							'greater_than',
							'greater_than_equal',
							'less_than',
							'less_than_equal',
							'between',
							'not_equal'
						)
						.optional(),
					search_value: Joi.when('search_type', {
						switch: [
							{ is: 'equals', then: Joi.any() },
							{
								is: 'between',
								then: Joi.array()
									.items(Joi.alternatives([Joi.string(), Joi.number()]))
									.length(2),
							},
						],
						otherwise: Joi.alternatives(Joi.string(), Joi.number()),
					}).required(),
				})
			)
		)
		.required(),
});

module.exports = function (searchObject, type) {
	let validationError = null;
	switch (type) {
		case 'value':
			validationError = validator.validateBySchema(searchObject, searchByValueSchema);
			break;
		case 'hashes':
			let errors;
			addError(checkValidTable('database', searchObject.schema));
			addError(checkValidTable('table', searchObject.table));
			if (!searchObject.hash_values) addError(`'hash_values' is required`);
			else if (!Array.isArray(searchObject.hash_values)) addError(`'hash_values' must be an array`);
			else if (!searchObject.hash_values.every((value) => typeof value === 'string' || typeof value === 'number'))
				addError(`'hash_values' must be strings or numbers`);
			if (!searchObject.get_attributes) addError(`'get_attributes' is required`);
			else if (!Array.isArray(searchObject.get_attributes)) addError(`'get_attributes' must be an array`);
			else if (searchObject.get_attributes.length === 0) addError(`'get_attributes' must contain at least 1 item`);
			else if (!searchObject.get_attributes.every((value) => typeof value === 'string' || typeof value === 'number'))
				addError(`'get_attributes' must be strings or numbers`);
			function addError(error) {
				if (errors) errors += '. ' + error;
				else errors = error;
			}
			if (errors) validationError = new Error(errors.trim());
			break;
		case 'conditions':
			validationError = validator.validateBySchema(searchObject, searchByConditionsSchema);
			break;
		default:
			throw new Error(`Error validating search, unknown type: ${type}`);
	}

	// validate table and attribute if format validation is valid
	if (!validationError && searchObject.schema !== 'system') {
		// skip validation for system schema
		//check if schema.table does not exist throw error
		let checkSchemaTable = hdbUtils.checkGlobalSchemaTable(searchObject.schema, searchObject.table);
		if (checkSchemaTable) {
			return handleHDBError(new Error(), checkSchemaTable, HTTP_STATUS_CODES.NOT_FOUND);
		}

		let tableSchema = getDatabases()[searchObject.schema][searchObject.table];
		let allTableAttributes = tableSchema.attributes;

		//this clones the get_attributes array
		let checkAttributes = searchObject.get_attributes ? [...searchObject.get_attributes] : [];

		if (type === 'value') {
			checkAttributes.push(searchObject.search_attribute);
		}

		//if search type is conditions add conditions fields to see if the fields exist
		const addConditions = (searchObject) => {
			//this is used to validate condition attributes exist in the schema
			for (let x = 0, length = searchObject.conditions.length; x < length; x++) {
				let condition = searchObject.conditions[x];
				if (condition.conditions) addConditions(condition);
				else checkAttributes.push(condition.search_attribute);
			}
		};
		if (type === 'conditions') {
			addConditions(searchObject);
		}

		let unknownAttributes = _.filter(
			checkAttributes,
			(attribute) =>
				attribute !== '*' &&
				!attribute.startsWith?.('$') && // meta attributes
				attribute.attribute !== '*' && // skip check for asterik attribute
				!Array.isArray(attribute) &&
				!attribute.name && // nested attribute
				!_.some(
					allTableAttributes,
					(
						tableAttribute // attribute should match one of the attribute in global
					) =>
						tableAttribute === attribute ||
						tableAttribute.attribute === attribute ||
						tableAttribute.attribute === attribute.attribute
				)
		);

		// if any unknown attributes present in the search request then list all indicated as unknown attribute to error message at once split in well format
		// for instance "unknown attribute a, b and c" or "unknown attribute a"
		if (unknownAttributes && unknownAttributes.length > 0) {
			// return error with proper message - replace last comma with and
			let errorMsg = unknownAttributes.join(', ');
			errorMsg = errorMsg.replace(/,([^,]*)$/, ' and$1');
			return new Error(`unknown attribute '${errorMsg}'`);
		}
	}

	return validationError;
};
