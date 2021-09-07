const _ = require('lodash'),
	validator = require('./validationWrapper');
const Joi = require('joi');
const hdb_terms = require('../utility/common_utils');
const { hdb_schema_table } = require('./common_validators');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

const search_by_hashes_schema = Joi.object({
	schema: hdb_schema_table,
	table: hdb_schema_table,
	hash_values: Joi.array().min(1).items(Joi.alternatives(Joi.string(), Joi.number())).required(),
	get_attributes: Joi.array().min(1).items(hdb_schema_table).required(),
});

const search_by_value_schema = Joi.object({
	schema: hdb_schema_table,
	table: hdb_schema_table,
	search_attribute: hdb_schema_table,
	search_value: Joi.any().required(),
	get_attributes: Joi.array().min(1).items(hdb_schema_table).required(),
	desc: Joi.bool(),
	limit: Joi.number().integer().min(1),
	offset: Joi.number().integer().min(0),
});

const search_by_conditions_schema = Joi.object({
	schema: hdb_schema_table,
	table: hdb_schema_table,
	operator: Joi.string().valid('and', 'or').default('and').lowercase(),
	offset: Joi.number().integer().min(0),
	limit: Joi.number().integer().min(1),
	get_attributes: Joi.array().min(1).items(hdb_schema_table).required(),
	conditions: Joi.array()
		.min(1)
		.items(
			Joi.object({
				search_attribute: hdb_schema_table,
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
						'between'
					)
					.required(),
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
		.required(),
});

module.exports = function (search_object, type) {
	let validation_error = null;
	switch (type) {
		case 'value':
			validation_error = validator.validateBySchema(search_object, search_by_value_schema);
			break;
		case 'hashes':
			validation_error = validator.validateBySchema(search_object, search_by_hashes_schema);
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
		let check_schema_table = hdb_terms.checkGlobalSchemaTable(search_object.schema, search_object.table);
		if (check_schema_table) {
			return handleHDBError(new Error(), check_schema_table, HTTP_STATUS_CODES.NOT_FOUND);
		}

		let table_schema = global.hdb_schema[search_object.schema][search_object.table];
		let all_table_attributes = table_schema.attributes;

		//this clones the get_attributes array
		let check_attributes = [...search_object.get_attributes];

		if (type === 'value') {
			check_attributes.push(search_object.search_attribute);
		}

		//if search type is conditions add conditions fields to see if the fields exist
		if (type === 'conditions') {
			//this is used to validate condition attributes exist in the schema
			for (let x = 0, length = search_object.conditions.length; x < length; x++) {
				let condition = search_object.conditions[x];
				check_attributes.push(condition.search_attribute);
			}
		}

		let unknown_attributes = _.filter(
			check_attributes,
			(attribute) =>
				attribute !== '*' &&
				attribute.attribute !== '*' && // skip check for asterik attribute
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
