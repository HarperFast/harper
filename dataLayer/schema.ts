'use strict';

import * as schemaMetadataValidator from '../validation/schemaMetadataValidator.ts';
import { validateBySchema } from '../validation/validationWrapper.ts';
import { commonValidators, schemaRegex } from '../validation/common_validators.ts';
import Joi from 'joi';
import logger from '../utility/logging/harper_logger.ts';
import { v4 as uuidV4 } from 'uuid';
import * as signalling from '../utility/signalling.ts';
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as util from 'util';
const harperBridge = require('./harperBridge/harperBridge').default;
import { handleHDBError, ClientError } from '../utility/errors/hdbError.ts';
import { HDB_ERROR_MSGS, HTTP_STATUS_CODES } from '../utility/errors/commonErrors.ts';

import { SchemaEventMsg } from '../server/threads/itc.js';
import { getDatabases, dropTableMeta } from '../resources/databases.ts';
import { transformReq } from '../utility/common_utils.ts';
import { server } from '../server/Server.ts';
import { cleanupOrphans } from '../resources/blob.ts';

const DB_NAME_CONSTRAINTS = Joi.string()
	.min(1)
	.max(commonValidators.schema_length.maximum)
	.pattern(schemaRegex)
	.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message });

const TABLE_NAME_CONSTRAINTS = Joi.string()
	.min(1)
	.max(commonValidators.schema_length.maximum)
	.pattern(schemaRegex)
	.messages({ 'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message })
	.required();

const PRIMARY_KEY_CONSTRAINTS = Joi.string()
	.min(1)
	.max(commonValidators.schema_length.maximum)
	.pattern(schemaRegex)
	.messages({
		'string.pattern.base': '{:#label} ' + commonValidators.schema_format.message,
		'any.required': "'primary_key' is required",
		'string.base': "'primary_key' must be a string",
	})
	.required();

/** EXPORTED FUNCTIONS **/

export async function createSchema(schemaCreateObject: any) {
	let schemaStructure = await createSchemaStructure(schemaCreateObject);
	signalling.signalSchemaChange(
		new SchemaEventMsg(process.pid, schemaCreateObject.operation, schemaCreateObject.schema)
	);

	return schemaStructure;
}

export async function createSchemaStructure(schemaCreateObject: any) {
	const validation = validateBySchema(
		schemaCreateObject,
		Joi.object({
			database: DB_NAME_CONSTRAINTS,
			schema: DB_NAME_CONSTRAINTS,
		})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(schemaCreateObject);

	if (!(await schemaMetadataValidator.checkSchemaExists(schemaCreateObject.schema))) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_EXISTS_ERR(schemaCreateObject.schema),
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdbTerms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.SCHEMA_EXISTS_ERR(schemaCreateObject.schema),
			true
		);
	}

	await harperBridge.createSchema(schemaCreateObject);

	return `database '${schemaCreateObject.schema}' successfully created`;
}

export async function createTable(createTableObject: any) {
	transformReq(createTableObject);
	createTableObject.primary_key = createTableObject.primary_key ?? createTableObject.hash_attribute;
	return await createTableStructure(createTableObject);
}

export async function createTableStructure(createTableObject: any) {
	const validation = validateBySchema(
		createTableObject,
		Joi.object({
			database: DB_NAME_CONSTRAINTS,
			schema: DB_NAME_CONSTRAINTS,
			table: TABLE_NAME_CONSTRAINTS,
			residence: Joi.array().items(Joi.string().min(1)).optional(),
			primary_key: PRIMARY_KEY_CONSTRAINTS,
		})
	);
	if (validation) throw new ClientError(validation.message);

	let invalidTableMsg = await schemaMetadataValidator.checkSchemaTableExists(
		createTableObject.schema,
		createTableObject.table
	);
	if (!invalidTableMsg) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.TABLE_EXISTS_ERR(createTableObject.schema, createTableObject.table),
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdbTerms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.TABLE_EXISTS_ERR(createTableObject.schema, createTableObject.table),
			true
		);
	}

	let tableSystemData: any = {
		name: createTableObject.table,
		schema: createTableObject.schema,
		id: uuidV4(),
		primary_key: createTableObject.primary_key,
	};

	if (createTableObject.residence) {
		if (global.clustering_on) {
			tableSystemData.residence = createTableObject.residence;
			await harperBridge.createTable(tableSystemData, createTableObject);
		} else {
			throw handleHDBError(
				new Error(),
				`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`,
				HTTP_STATUS_CODES.BAD_REQUEST
			);
		}
	} else {
		await harperBridge.createTable(tableSystemData, createTableObject);
	}

	return `table '${createTableObject.schema}.${createTableObject.table}' successfully created.`;
}

export async function dropSchema(dropSchemaObject: any) {
	const validation = validateBySchema(
		dropSchemaObject,
		Joi.object({
			database: Joi.string(),
			schema: Joi.string(),
		})
			.or('database', 'schema')
			.messages({
				'object.missing': "'database' is required",
			})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(dropSchemaObject);

	let invalidSchemaMsg = await schemaMetadataValidator.checkSchemaExists(dropSchemaObject.schema);
	if (invalidSchemaMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdbTerms.LOG_LEVELS.ERROR,
			invalidSchemaMsg,
			true
		);
	}

	await harperBridge.dropSchema(dropSchemaObject);
	signalling.signalSchemaChange(new SchemaEventMsg(process.pid, dropSchemaObject.operation, dropSchemaObject.schema));

	let response = await server.replication.replicateOperation(dropSchemaObject);
	response.message = `successfully deleted '${dropSchemaObject.schema}'`;
	return response;
}

export async function dropTable(dropTableObject: any) {
	const validation = validateBySchema(
		dropTableObject,
		Joi.object({
			database: Joi.string(),
			schema: Joi.string(),
			table: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(dropTableObject);

	let invalidSchemaTableMsg = await schemaMetadataValidator.checkSchemaTableExists(
		dropTableObject.schema,
		dropTableObject.table
	);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdbTerms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	await harperBridge.dropTable(dropTableObject);

	await dropTableMeta({ table: dropTableObject.table, database: dropTableObject.schema });

	let response = await server.replication.replicateOperation(dropTableObject);
	response.message = `successfully deleted table '${dropTableObject.schema}.${dropTableObject.table}'`;
	return response;
}

/**
 * Drops all files for the specified attribute.
 * @param dropAttributeObject - The JSON formatted inbound message.
 * @returns {Promise<*>}
 */
export async function dropAttribute(dropAttributeObject: any) {
	const validation = validateBySchema(
		dropAttributeObject,
		Joi.object({
			database: Joi.string(),
			schema: Joi.string(),
			table: Joi.string().required(),
			attribute: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(dropAttributeObject);

	let invalidSchemaTableMsg = await schemaMetadataValidator.checkSchemaTableExists(
		dropAttributeObject.schema,
		dropAttributeObject.table
	);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdbTerms.LOG_LEVELS.ERROR,
			invalidSchemaTableMsg,
			true
		);
	}

	if (
		dropAttributeObject.attribute ===
		global.hdb_schema[dropAttributeObject.schema][dropAttributeObject.table].primary_key
	) {
		throw handleHDBError(
			new Error(),
			'You cannot drop a hash attribute',
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (hdbTerms.TIME_STAMP_NAMES.indexOf(dropAttributeObject.attribute) >= 0) {
		throw handleHDBError(
			new Error(),
			`cannot drop internal timestamp attribute: ${dropAttributeObject.attribute}`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	try {
		await harperBridge.dropAttribute(dropAttributeObject);
		dropAttributeFromGlobal(dropAttributeObject);
		signalling.signalSchemaChange(
			new SchemaEventMsg(
				process.pid,
				dropAttributeObject.operation,
				dropAttributeObject.schema,
				dropAttributeObject.table,
				dropAttributeObject.attribute
			)
		);

		return `successfully deleted attribute '${dropAttributeObject.attribute}'`;
	} catch (err) {
		logger.error(`Got an error deleting attribute ${util.inspect(dropAttributeObject)}.`);
		throw err;
	}
}

/**
 * Removes the dropped attribute from the global hdb schema object.
 * @param dropAttributeObject
 */
function dropAttributeFromGlobal(dropAttributeObject) {
	let attributesObj = Object.values(
		global.hdb_schema[dropAttributeObject.schema][dropAttributeObject.table]['attributes']
	);

	for (let i = 0; i < attributesObj.length; i++) {
		if ((attributesObj[i] as any).attribute === dropAttributeObject.attribute) {
			global.hdb_schema[dropAttributeObject.schema][dropAttributeObject.table]['attributes'].splice(i, 1);
		}
	}
}

export async function createAttribute(createAttributeObject: any) {
	transformReq(createAttributeObject);

	const tableAttr = getDatabases()[createAttributeObject.schema][createAttributeObject.table].attributes;
	for (const { name } of tableAttr) {
		if (name === createAttributeObject.attribute) {
			throw handleHDBError(
				new Error(),
				`attribute '${createAttributeObject.attribute}' already exists in ${createAttributeObject.schema}.${createAttributeObject.table}`,
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
	}

	await harperBridge.createAttribute(createAttributeObject);
	signalling.signalSchemaChange(
		new SchemaEventMsg(
			process.pid,
			createAttributeObject.operation,
			createAttributeObject.schema,
			createAttributeObject.table,
			createAttributeObject.attribute
		)
	);

	return `attribute '${createAttributeObject.schema}.${createAttributeObject.table}.${createAttributeObject.attribute}' successfully created.`;
}

export function getBackup(getBackupObject: any) {
	return harperBridge.getBackup(getBackupObject);
}

export function cleanupOrphanBlobs(request: any) {
	if (!request.database) throw new ClientError('Must provide "database" name for search for orphaned blobs');
	const database: any = (databases as any)[request.database];
	if (!database) throw new ClientError(`Unknown database '${request.database}'`);
	// don't await, it will probably take hours
	cleanupOrphans((databases as any)[request.database], request.database);
	return { message: 'Orphaned blobs cleanup started, check logs for progress' };
}
