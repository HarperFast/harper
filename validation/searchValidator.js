const _ = require('lodash'),
	validator = require('./validationWrapper');
const Joi = require('joi');
const hdb_utils = require('../utility/common_utils');
const { hdb_schema_table, checkValidTable, hdb_table, hdb_database } = require('./common_validators');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { getDatabases } = require('../resources/databases');
const { HTTP_STATUS_CODES } = hdb_errors;

const search_by_value_schema = Joi.object({
	database: hdb_database,
	schema: hdb_database,
	table: hdb_table,
	search_attribute: hdb_schema_table,
	search_value: Joi.any().required(),
	get_attributes: Joi.array().min(1).items(Joi.alternatives(hdb_schema_table, Joi.object())).optional(),
	desc: Joi.bool(),
	limit: Joi.number().integer().min(1),
	offset: Joi.number().integer().min(0),
});

const search_by_conditions_schema = Joi.object({
	database: hdb_database,
	schema: hdb_database,
	table: hdb_table,
	operator: Joi.string().valid('and', 'or').default('and').lowercase(),
	offset: Joi.number().integer().min(0),
	limit: Joi.number().integer().min(1),
	get_attributes: Joi.array().min(1).items(Joi.alternatives(hdb_schema_table, Joi.object())).optional(),
	sort: Joi.object({
		attribute: Joi.alternatives(hdb_schema_table, Joi.array().min(1)),
		descending: Joi.bool().optional(),
	}).optional(),
	conditions: Joi.array()
		.min(1)
		.items(
			Joi.alternatives(
				Joi.object({ operator: Joi.string().valid('and', 'or').default('and').lowercase(), conditions: Joi.array() }),
				Joi.object({
					search_attribute: Joi.alternatives(hdb_schema_table, Joi.array().min(1)),
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

module.exports = function (search_object, type) {
	let validation_error = null;
	switch (type) {
		case 'value':
			validation_error = validator.validateBySchema(search_object, search_by_value_schema);
			break;
		case 'hashes':
			let errors;
			addError(checkValidTable('database', search_object.schema));
			addError(checkValidTable('table', search_object.table));
			if (!search_object.hash_values) addError(`'hash_values' is required`);
			else if (!Array.isArray(search_object.hash_values)) addError(`'hash_values' must be an array`);
			else if (!search_object.hash_values.every((value) => typeof value === 'string' || typeof value === 'number'))
				addError(`'hash_values' must be strings or numbers`);
			if (!search_object.get_attributes) addError(`'get_attributes' is required`);
			else if (!Array.isArray(search_object.get_attributes)) addError(`'get_attributes' must be an array`);
			else if (search_object.get_attributes.length === 0) addError(`'get_attributes' must contain at least 1 item`);
			else if (!search_object.get_attributes.every((value) => typeof value === 'string' || typeof value === 'number'))
				addError(`'get_attributes' must be strings or numbers`);
			function addError(error) {
				if (errors) errors += '. ' + error;
				else errors = error;
			}
			if (errors) validation_error = new Error(errors.trim());
			break;
		case 'conditions':
			validation_error = validator.validateBySchema(search_object, search_by_conditions_schema);
			break;
		default:
			throw new Error(`Error validating search, unknown type: ${type}`);
	}

	// validate table and attribute if format validation is valid
	if (!validation_error && search_object.schema !== 'system') {
		// skip validation for system schema
		//check if schema.table does not exist throw error
		let check_schema_table = hdb_utils.checkGlobalSchemaTable(search_object.schema, search_object.table);
		if (check_schema_table) {
			return handleHDBError(new Error(), check_schema_table, HTTP_STATUS_CODES.NOT_FOUND);
		}

		let table_schema = getDatabases()[search_object.schema][search_object.table];
		let all_table_attributes = table_schema.attributes;

		//this clones the get_attributes array
		let check_attributes = search_object.get_attributes ? [...search_object.get_attributes] : [];

		if (type === 'value') {
			check_attributes.push(search_object.search_attribute);
		}

		//if search type is conditions add conditions fields to see if the fields exist
		const addConditions = (search_object) => {
			//this is used to validate condition attributes exist in the schema
			for (let x = 0, length = search_object.conditions.length; x < length; x++) {
				let condition = search_object.conditions[x];
				if (condition.conditions) addConditions(condition);
				else check_attributes.push(condition.search_attribute);
			}
		};
		if (type === 'conditions') {
			addConditions(search_object);
		}

		let unknown_attributes = _.filter(
			check_attributes,
			(attribute) =>
				attribute !== '*' &&
				!attribute.startsWith?.('$') && // meta attributes
				attribute.attribute !== '*' && // skip check for asterik attribute
				!Array.isArray(attribute) &&
				!attribute.name && // nested attribute
				!_.some(
					all_table_attributes,
					(
						table_attribute // attribute should match one of the attribute in global
					) =>
						table_attribute === attribute ||
						table_attribute.attribute === attribute ||
						table_attribute.attribute === attribute.attribute
				)
		);

		// if any unknown attributes present in the search request then list all indicated as unknown attribute to error message at once split in well format
		// for instance "unknown attribute a, b and c" or "unknown attribute a"
		if (unknown_attributes && unknown_attributes.length > 0) {
			// return error with proper message - replace last comma with and
			let error_msg = unknown_attributes.join(', ');
			error_msg = error_msg.replace(/,([^,]*)$/, ' and$1');
			return new Error(`unknown attribute '${error_msg}'`);
		}
	}

	return validation_error;
};
