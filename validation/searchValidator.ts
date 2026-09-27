import * as _ from 'lodash';
import * as validator from './validationWrapper.ts';
import Joi from 'joi';
import * as hdbUtils from '../utility/common_utils.ts';
import { hdbSchemaTable, checkValidTable, hdbTable, hdbDatabase } from './common_validators.ts';
import { handleHDBError, hdbErrors } from '../utility/errors/hdbError.ts';
import { getDatabases } from '../resources/databases.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const FULL_TEXT_COMPARATORS = [
	'matches',
	'matches_all',
	'matches_phrase',
	'matches_prefix',
	'matches_fuzzy',
	'matches_fuzzy_prefix',
	'not_matches',
	'not_matches_all',
	'not_matches_phrase',
	'not_matches_prefix',
	'not_matches_fuzzy',
	'not_matches_fuzzy_prefix',
] as const;
const FULL_TEXT_COMPARATOR_SET = new Set<string>(FULL_TEXT_COMPARATORS);
const SEARCH_BY_CONDITIONS_COMPARATORS = [
	'equals',
	'contains',
	'starts_with',
	'ends_with',
	'greater_than',
	'greater_than_equal',
	'less_than',
	'less_than_equal',
	'between',
	'not_equal',
	...FULL_TEXT_COMPARATORS,
] as const;

const searchByValueSchema = Joi.object({
	database: hdbDatabase,
	schema: hdbDatabase,
	table: hdbTable,
	attribute: hdbSchemaTable,
	value: Joi.any().required(),
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
					attribute: Joi.alternatives(hdbSchemaTable, Joi.array().min(1)),
					comparator: Joi.string()
						.valid(...SEARCH_BY_CONDITIONS_COMPARATORS)
						.optional(),
					fields: Joi.array().min(1).items(hdbSchemaTable).optional(),
					includeHighlights: Joi.bool().optional(),
					maxIndexLagMilliseconds: Joi.number().min(0).optional(),
					waitForIndexMilliseconds: Joi.number().min(0).max(30_000).optional(),
					value: Joi.when('comparator', {
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

export default function (searchObject: any, type: any) {
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
		const fullTextNames = new Set((tableSchema.fullTextIndexes ?? []).map(({ name }) => name));

		//this clones the get_attributes array
		let checkAttributes = searchObject.get_attributes ? [...searchObject.get_attributes] : [];

		if (type === 'value') {
			checkAttributes.push(searchObject.attribute);
		}

		//if search type is conditions add conditions fields to see if the fields exist
		const addConditions = (searchObject) => {
			//this is used to validate condition attributes exist in the schema
			for (const condition of searchObject.conditions) {
				if (condition.conditions) addConditions(condition);
				else if (!FULL_TEXT_COMPARATOR_SET.has(condition.comparator)) checkAttributes.push(condition.attribute);
				else if (!fullTextNames.has(condition.attribute)) checkAttributes.push(condition.attribute);
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
				attribute.attribute !== '*' && // skip check for asterisk attribute
				!Array.isArray(attribute) &&
				!attribute.name && // nested attribute
				!_.some(
					allTableAttributes,
					(
						tableAttribute: any // attribute should match one of the attribute in global
					) =>
						tableAttribute === attribute ||
						tableAttribute.attribute === attribute ||
						tableAttribute.attribute === (attribute as any).attribute
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
}
