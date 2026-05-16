import * as hUtils from '../../../../utility/common_utils.ts';
import * as hdbTerms from '../../../../utility/hdbTerms.ts';
import logger from '../../../../utility/logging/harper_logger.ts';
import lmdbCreateAttribute from '../lmdbMethods/lmdbCreateAttribute.ts';
const LMDBCreateAttributeObject =
	require('./LMDBCreateAttributeObject.ts').default || require('./LMDBCreateAttributeObject.ts');
import * as signalling from '../../../../utility/signalling.ts';
import { SchemaEventMsg } from '../../../../server/threads/itc.ts';

const ATTRIBUTE_ALREADY_EXISTS = 'already exists in';

export default lmdbCheckForNewAttributes;

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
