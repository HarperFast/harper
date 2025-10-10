'use strict';

const hUtils = require('../../../../utility/common_utils.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const logger = require('../../../../utility/logging/harper_logger.js');
const lmdbCreateAttribute = require('../lmdbMethods/lmdbCreateAttribute.js');
const LMDBCreateAttributeObject = require('./LMDBCreateAttributeObject.js');
const signalling = require('../../../../utility/signalling.js');
const { SchemaEventMsg } = require('../../../../server/threads/itc.js');

const ATTRIBUTE_ALREADY_EXISTS = 'already exists in';

module.exports = lmdbCheckForNewAttributes;

/**
 * Uses a utility function to check if there are any new attributes that dont exist. Utility function
 * references the global schema.
 * @param hdbAuthHeader
 * @param tableSchema
 * @param dataAttributes
 */
async function lmdbCheckForNewAttributes(hdbAuthHeader, tableSchema, dataAttributes) {
	if (hUtils.isEmptyOrZeroLength(dataAttributes)) {
		return dataAttributes;
	}

	let rawAttributes = [];
	if (!hUtils.isEmptyOrZeroLength(tableSchema.attributes)) {
		tableSchema.attributes.forEach((attribute) => {
			rawAttributes.push(attribute.attribute);
		});
	}

	let new_attributes = dataAttributes.filter((attribute) => rawAttributes.indexOf(attribute) < 0);

	if (new_attributes.length === 0) {
		return new_attributes;
	}

	await Promise.all(
		new_attributes.map(async (attribute) => {
			await createNewAttribute(hdbAuthHeader, tableSchema.schema, tableSchema.name, attribute);
		})
	);

	return new_attributes;
}

/**
 * check the existing schema and creates new attributes based on what the incoming records have
 * @param hdbAuthHeader
 * @param schema
 * @param table
 * @param attribute
 */
async function createNewAttribute(hdbAuthHeader, schema, table, attribute) {
	let attributeObject = new LMDBCreateAttributeObject(schema, table, attribute, undefined, true);

	if (hdbAuthHeader) {
		attributeObject.hdb_auth_header = hdbAuthHeader;
	}

	try {
		await createAttribute(attributeObject);
	} catch (e) {
		//if the attribute already exists we do not want to stop the insert
		if (typeof e === 'object' && e.message !== undefined && e.message.includes(ATTRIBUTE_ALREADY_EXISTS)) {
			logger.warn(`attribute ${schema}.${table}.${attribute} already exists`);
		} else {
			throw e;
		}
	}
}

/**
 *
 * @param {LMDBCreateAttributeObject} createAttributeObject
 * @returns {Promise<*>}
 */
async function createAttribute(createAttributeObject) {
	let attributeStructure;
	attributeStructure = await lmdbCreateAttribute(createAttributeObject);
	signalling.signalSchemaChange(
		new SchemaEventMsg(
			process.pid,
			hdbTerms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
			createAttributeObject.schema,
			createAttributeObject.table,
			createAttributeObject.attribute
		)
	);

	return attributeStructure;
}
