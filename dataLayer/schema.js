'use strict';

const schemaMetadataValidator = require('../validation/schemaMetadataValidator.js');
const { validateBySchema } = require('../validation/validationWrapper.js');
const { commonValidators, schemaRegex } = require('../validation/common_validators.js');
const Joi = require('joi');
const logger = require('../utility/logging/harper_logger.js');
const uuidV4 = require('uuid').v4;
const signalling = require('../utility/signalling.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const util = require('util');
const harperBridge = require('./harperBridge/harperBridge.js');
const { handleHDBError, hdbErrors, ClientError } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const { SchemaEventMsg } = require('../server/threads/itc.js');
const natsUtils = require('../server/nats/utility/natsUtils.js');
const { getDatabases } = require('../resources/databases.ts');
const { transformReq } = require('../utility/common_utils.js');
const { replicateOperation } = require('../server/replication/replicator.ts');
const { cleanupOrphans } = require('../resources/blob.ts');

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

module.exports = {
	createSchema,
	createSchemaStructure,
	createTable,
	createTableStructure,
	createAttribute,
	dropSchema,
	dropTable,
	dropAttribute,
	getBackup,
	cleanupOrphanBlobs,
};

/** EXPORTED FUNCTIONS **/

async function createSchema(schemaCreateObject) {
	let schemaStructure = await createSchemaStructure(schemaCreateObject);
	signalling.signalSchemaChange(
		new SchemaEventMsg(process.pid, schemaCreateObject.operation, schemaCreateObject.schema)
	);

	return schemaStructure;
}

async function createSchemaStructure(schemaCreateObject) {
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

async function createTable(createTableObject) {
	transformReq(createTableObject);
	createTableObject.hash_attribute = createTableObject.primary_key ?? createTableObject.hash_attribute;
	return await createTableStructure(createTableObject);
}

async function createTableStructure(createTableObject) {
	const validation = validateBySchema(
		createTableObject,
		Joi.object({
			database: DB_NAME_CONSTRAINTS,
			schema: DB_NAME_CONSTRAINTS,
			table: TABLE_NAME_CONSTRAINTS,
			residence: Joi.array().items(Joi.string().min(1)).optional(),
			hash_attribute: PRIMARY_KEY_CONSTRAINTS,
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

	let tableSystemData = {
		name: createTableObject.table,
		schema: createTableObject.schema,
		id: uuidV4(),
		hash_attribute: createTableObject.hash_attribute,
	};

	try {
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
	} catch (err) {
		throw err;
	}
}

async function dropSchema(dropSchemaObject) {
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

	//we refresh and assign the entire schema metadata to global in order to make sure we have the latest
	let schema = await schemaMetadataValidator.schemaDescribe.describeSchema({ schema: dropSchemaObject.schema });
	//global.hdb_schema[dropSchemaObject.schema] = schema;

	// Get all the tables that belong to schema.
	const tables = Object.keys(global.hdb_schema[dropSchemaObject.schema]);

	await harperBridge.dropSchema(dropSchemaObject);
	signalling.signalSchemaChange(new SchemaEventMsg(process.pid, dropSchemaObject.operation, dropSchemaObject.schema));

	//delete global.hdb_schema[dropSchemaObject.schema];

	// Purge the streams for all tables that were part of schema.
	// Streams are part of Nats and are used by clustering, they are 'message stores' that track transactions on a table.
	await natsUtils.purgeSchemaTableStreams(dropSchemaObject.schema, tables);
	let response = await replicateOperation(dropSchemaObject);
	response.message = `successfully deleted '${dropSchemaObject.schema}'`;
	return response;
}

async function dropTable(dropTableObject) {
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

	// Purge tables local stream. Streams are part of Nats and are used by clustering, they are 'message stores' that track transactions on a table.
	await natsUtils.purgeTableStream(dropTableObject.schema, dropTableObject.table);

	let response = await replicateOperation(dropTableObject);
	response.message = `successfully deleted table '${dropTableObject.schema}.${dropTableObject.table}'`;
	return response;
}

/**
 * Drops all files for the specified attribute.
 * @param dropAttributeObject - The JSON formatted inbound message.
 * @returns {Promise<*>}
 */
async function dropAttribute(dropAttributeObject) {
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
		global.hdb_schema[dropAttributeObject.schema][dropAttributeObject.table].hash_attribute
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
		if (attributesObj[i].attribute === dropAttributeObject.attribute) {
			global.hdb_schema[dropAttributeObject.schema][dropAttributeObject.table]['attributes'].splice(i, 1);
		}
	}
}

async function createAttribute(createAttributeObject) {
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

function getBackup(getBackupObject) {
	return harperBridge.getBackup(getBackupObject);
}

function cleanupOrphanBlobs(request) {
	if (!request.database) throw new ClientError('Must provide "database" name for search for orphaned blobs');
	const database = databases[request.database];
	if (!database) throw new ClientError(`Unknown database '${request.database}'`);
	// don't await, it will probably take hours
	cleanupOrphans(databases[request.database]);
	return { message: 'Orphaned blobs cleanup started, check logs for progress' };
}
