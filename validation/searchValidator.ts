import uniqBy from 'lodash/uniqBy.js';
import * as validator from './validationWrapper.ts';
import Joi from 'joi';
import * as hdbUtils from '../utility/common_utils.ts';
import { hdbSchemaTable, checkValidTable, hdbTable, hdbDatabase } from './common_validators.ts';
import { ClientError, handleHDBError, hdbErrors } from '../utility/errors/hdbError.ts';
import { getDatabases } from '../resources/databases.ts';
import { FULL_TEXT_COMPARATORS } from '../resources/indexes/fullTextQueryProtocol.ts';

const { HTTP_STATUS_CODES } = hdbErrors;
const MAX_SELECT_DEPTH = 64;
const FULL_TEXT_COMPARATOR_SET = new Set<string>(FULL_TEXT_COMPARATORS);

interface VisitedSelectorState {
	bySchema?: WeakMap<object, WeakSet<object>>;
	withoutSchema?: WeakSet<object>;
}

function getVisitedSet(state: VisitedSelectorState, schema: any): WeakSet<object> {
	if (!schema || (typeof schema !== 'object' && typeof schema !== 'function')) {
		return (state.withoutSchema ??= new WeakSet<object>());
	}
	state.bySchema ??= new WeakMap<object, WeakSet<object>>();
	let set = state.bySchema.get(schema);
	if (!set) {
		set = new WeakSet<object>();
		state.bySchema.set(schema, set);
	}
	return set;
}

function findMatchingTableAttribute(tableAttributes: any[], attributeName: any): any {
	for (let i = 0; i < tableAttributes.length; i++) {
		const tableAttribute = tableAttributes[i];
		if (
			tableAttribute === attributeName ||
			tableAttribute?.attribute === attributeName ||
			tableAttribute?.name === attributeName
		) {
			return tableAttribute;
		}
	}
	return undefined;
}

function collectUnknownAttributes(
	attributesToCheck: any[],
	currentTableSchema: any,
	unknownAttributes: any[],
	depth = 0,
	visitedState?: VisitedSelectorState
) {
	const tableAttributes = currentTableSchema?.attributes || [];
	let visitedObjects: WeakSet<object> | undefined;
	for (const attribute of attributesToCheck) {
		if (
			attribute === '*' ||
			(typeof attribute === 'string' && attribute.startsWith('$')) || // meta attributes
			Array.isArray(attribute)
		) {
			continue;
		}
		if (attribute && typeof attribute === 'object') {
			if (typeof attribute.name !== 'string' || attribute.name.length === 0) {
				unknownAttributes.push(attribute);
				continue;
			}
			visitedObjects ??= getVisitedSet((visitedState ??= {}), currentTableSchema);
			if (visitedObjects.has(attribute)) continue;
			visitedObjects.add(attribute);
			const matchedAttribute = findMatchingTableAttribute(tableAttributes, attribute.name);
			if (!matchedAttribute) {
				unknownAttributes.push(attribute.name);
				continue;
			}
			if (attribute.conditions !== undefined) {
				unknownAttributes.push(`${attribute.name} (conditions are not allowed in get_attributes)`);
				continue;
			}
			if (attribute.offset !== undefined && (!Number.isInteger(attribute.offset) || attribute.offset < 0)) {
				unknownAttributes.push(`${attribute.name} (invalid offset)`);
				continue;
			}
			if (attribute.limit !== undefined && (!Number.isInteger(attribute.limit) || attribute.limit < 0)) {
				unknownAttributes.push(`${attribute.name} (invalid limit)`);
				continue;
			}
			if (attribute.select !== undefined) {
				if (
					typeof attribute.select !== 'string' &&
					(!Array.isArray(attribute.select) || attribute.select.length === 0)
				) {
					unknownAttributes.push(`${attribute.name} (invalid select)`);
					continue;
				}
				if (depth >= MAX_SELECT_DEPTH) {
					unknownAttributes.push(`${attribute.name} (select depth exceeded)`);
					continue;
				}
				const targetTable =
					(matchedAttribute.definition || matchedAttribute.elements?.definition)?.tableClass ??
					currentTableSchema?.propertyResolvers?.[attribute.name]?.definition?.tableClass;
				if (targetTable?.attributes) {
					const nestedSelect = Array.isArray(attribute.select) ? attribute.select : [attribute.select];
					collectUnknownAttributes(nestedSelect, targetTable, unknownAttributes, depth + 1, visitedState);
				}
			}
			continue;
		}
		if (!findMatchingTableAttribute(tableAttributes, attribute)) {
			unknownAttributes.push(attribute);
		}
	}
}
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
	value: Joi.any()
		.custom((value, helpers) => {
			if (Array.isArray(value) || (value !== null && typeof value === 'object' && !(value instanceof Date))) {
				return helpers.error('any.invalid');
			}
			return value;
		})
		.required()
		.messages({
			'any.invalid': '{{#label}} must not be an array or object',
		}),
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
			else if (
				!searchObject.get_attributes.every(
					(value) =>
						typeof value === 'string' ||
						typeof value === 'number' ||
						(typeof value === 'object' && value !== null && !Array.isArray(value))
				)
			)
				addError(`'get_attributes' must be strings, numbers, or objects`);
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

		let tableSchema: any = getDatabases()[searchObject.schema][searchObject.table];

		//this clones the get_attributes array
		let checkAttributes = searchObject.get_attributes ? [...searchObject.get_attributes] : [];

		if (type === 'value') {
			checkAttributes.push(searchObject.attribute);
		}

		if (type === 'conditions') {
			//if search type is conditions add conditions fields to see if the fields exist
			const addConditions = (condGroup) => {
				//this is used to validate condition attributes exist in the schema
				for (const condition of condGroup.conditions) {
					if (condition.conditions) addConditions(condition);
					// Table.search resolves full-text names together with source-field authorization.
					else if (!FULL_TEXT_COMPARATOR_SET.has(condition.comparator)) checkAttributes.push(condition.attribute);
				}
			};
			addConditions(searchObject);
		}

		let unknownAttributes: any[] = [];
		collectUnknownAttributes(checkAttributes, tableSchema, unknownAttributes);

		// if any unknown attributes present in the search request then list all indicated as unknown attribute to error message at once split in well format
		// for instance "unknown attribute a, b and c" or "unknown attribute a"
		if (unknownAttributes && unknownAttributes.length > 0) {
			// get_attributes/conditions impose no length limit, so this must stay O(n)
			unknownAttributes = uniqBy(unknownAttributes, (value: any) => {
				if (typeof value !== 'object') return value;
				try {
					// bigint properties (reachable via msgpack/cbor) are converted rather than left to
					// throw; the leading NUL can't collide with a string attribute name (schemaRegex
					// forbids control characters), so an object key never matches a primitive one
					return (
						'\0' +
						JSON.stringify(value, (_key, propValue) =>
							typeof propValue === 'bigint' ? propValue.toString() : propValue
						)
					);
				} catch {
					// anything else that can't be stringified (e.g. a circular object) dedupes only by
					// reference identity, never by structural equality, rather than throwing
					return value;
				}
			});
			// return error with proper message - replace last comma with and
			let errorMsg = unknownAttributes
				.map((attr) => (typeof attr === 'string' || typeof attr === 'number' ? String(attr) : '[object Object]'))
				.join(', ');
			errorMsg = errorMsg.replace(/,([^,]*)$/, ' and$1');
			return new ClientError(`unknown attribute '${errorMsg}'`);
		}
	}

	return validationError;
}
