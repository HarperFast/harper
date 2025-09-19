'use strict';

const schema_metadata_validator = require('../validation/schemaMetadataValidator');
const { validateBySchema } = require('../validation/validationWrapper');
const { common_validators, schema_regex } = require('../validation/common_validators');
const Joi = require('joi');
const logger = require('../utility/logging/harper_logger');
const uuidV4 = require('uuid').v4;
const signalling = require('../utility/signalling');
const hdb_terms = require('../utility/hdbTerms');
const util = require('util');
const harperBridge = require('./harperBridge/harperBridge');
const { handleHDBError, hdb_errors, ClientError } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const { SchemaEventMsg } = require('../server/threads/itc');
const nats_utils = require('../server/nats/utility/natsUtils');
const { getDatabases } = require('../resources/databases');
const { transformReq } = require('../utility/common_utils');
const { replicateOperation } = require('../server/replication/replicator');
const { cleanupOrphans } = require('../resources/blob');

const DB_NAME_CONSTRAINTS = Joi.string()
	.min(1)
	.max(common_validators.schema_length.maximum)
	.pattern(schema_regex)
	.messages({ 'string.pattern.base': '{:#label} ' + common_validators.schema_format.message });

const TABLE_NAME_CONSTRAINTS = Joi.string()
	.min(1)
	.max(common_validators.schema_length.maximum)
	.pattern(schema_regex)
	.messages({ 'string.pattern.base': '{:#label} ' + common_validators.schema_format.message })
	.required();

const PRIMARY_KEY_CONSTRAINTS = Joi.string()
	.min(1)
	.max(common_validators.schema_length.maximum)
	.pattern(schema_regex)
	.messages({
		'string.pattern.base': '{:#label} ' + common_validators.schema_format.message,
		'any.required': "'primary_key' is required",
		'string.base': "'primary_key' must be a string",
	})
	.required();

module.exports = {
	createSchema: createSchema,
	createSchemaStructure: createSchemaStructure,
	createTable: createTable,
	createTableStructure: createTableStructure,
	createAttribute: createAttribute,
	dropSchema: dropSchema,
	dropTable: dropTable,
	dropAttribute: dropAttribute,
	getBackup,
	cleanupOrphanBlobs,
};

/** EXPORTED FUNCTIONS **/

async function createSchema(schema_create_object) {
	let schema_structure = await createSchemaStructure(schema_create_object);
	signalling.signalSchemaChange(
		new SchemaEventMsg(process.pid, schema_create_object.operation, schema_create_object.schema)
	);

	return schema_structure;
}

async function createSchemaStructure(schema_create_object) {
	const validation = validateBySchema(
		schema_create_object,
		Joi.object({
			database: DB_NAME_CONSTRAINTS,
			schema: DB_NAME_CONSTRAINTS,
		})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(schema_create_object);

	if (!(await schema_metadata_validator.checkSchemaExists(schema_create_object.schema))) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_EXISTS_ERR(schema_create_object.schema),
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdb_terms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.SCHEMA_EXISTS_ERR(schema_create_object.schema),
			true
		);
	}

	await harperBridge.createSchema(schema_create_object);

	return `database '${schema_create_object.schema}' successfully created`;
}

async function createTable(create_table_object) {
	transformReq(create_table_object);
	create_table_object.hash_attribute = create_table_object.primary_key ?? create_table_object.hash_attribute;
	return await createTableStructure(create_table_object);
}

async function createTableStructure(create_table_object) {
	const validation = validateBySchema(
		create_table_object,
		Joi.object({
			database: DB_NAME_CONSTRAINTS,
			schema: DB_NAME_CONSTRAINTS,
			table: TABLE_NAME_CONSTRAINTS,
			residence: Joi.array().items(Joi.string().min(1)).optional(),
			hash_attribute: PRIMARY_KEY_CONSTRAINTS,
		})
	);
	if (validation) throw new ClientError(validation.message);

	let invalid_table_msg = await schema_metadata_validator.checkSchemaTableExists(
		create_table_object.schema,
		create_table_object.table
	);
	if (!invalid_table_msg) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.TABLE_EXISTS_ERR(create_table_object.schema, create_table_object.table),
			HTTP_STATUS_CODES.BAD_REQUEST,
			hdb_terms.LOG_LEVELS.ERROR,
			HDB_ERROR_MSGS.TABLE_EXISTS_ERR(create_table_object.schema, create_table_object.table),
			true
		);
	}

	let table_system_data = {
		name: create_table_object.table,
		schema: create_table_object.schema,
		id: uuidV4(),
		hash_attribute: create_table_object.hash_attribute,
	};

	try {
		if (create_table_object.residence) {
			if (global.clustering_on) {
				table_system_data.residence = create_table_object.residence;
				await harperBridge.createTable(table_system_data, create_table_object);
			} else {
				throw handleHDBError(
					new Error(),
					`Clustering does not appear to be enabled. Cannot insert table with property 'residence'.`,
					HTTP_STATUS_CODES.BAD_REQUEST
				);
			}
		} else {
			await harperBridge.createTable(table_system_data, create_table_object);
		}

		return `table '${create_table_object.schema}.${create_table_object.table}' successfully created.`;
	} catch (err) {
		throw err;
	}
}

async function dropSchema(drop_schema_object) {
	const validation = validateBySchema(
		drop_schema_object,
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

	transformReq(drop_schema_object);

	let invalid_schema_msg = await schema_metadata_validator.checkSchemaExists(drop_schema_object.schema);
	if (invalid_schema_msg) {
		throw handleHDBError(
			new Error(),
			invalid_schema_msg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdb_terms.LOG_LEVELS.ERROR,
			invalid_schema_msg,
			true
		);
	}

	//we refresh and assign the entire schema metadata to global in order to make sure we have the latest
	let schema = await schema_metadata_validator.schema_describe.describeSchema({ schema: drop_schema_object.schema });
	//global.hdb_schema[drop_schema_object.schema] = schema;

	// Get all the tables that belong to schema.
	const tables = Object.keys(global.hdb_schema[drop_schema_object.schema]);

	await harperBridge.dropSchema(drop_schema_object);
	signalling.signalSchemaChange(
		new SchemaEventMsg(process.pid, drop_schema_object.operation, drop_schema_object.schema)
	);

	//delete global.hdb_schema[drop_schema_object.schema];

	// Purge the streams for all tables that were part of schema.
	// Streams are part of Nats and are used by clustering, they are 'message stores' that track transactions on a table.
	await nats_utils.purgeSchemaTableStreams(drop_schema_object.schema, tables);
	let response = await replicateOperation(drop_schema_object);
	response.message = `successfully deleted '${drop_schema_object.schema}'`;
	return response;
}

async function dropTable(drop_table_object) {
	const validation = validateBySchema(
		drop_table_object,
		Joi.object({
			database: Joi.string(),
			schema: Joi.string(),
			table: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(drop_table_object);

	let invalid_schema_table_msg = await schema_metadata_validator.checkSchemaTableExists(
		drop_table_object.schema,
		drop_table_object.table
	);
	if (invalid_schema_table_msg) {
		throw handleHDBError(
			new Error(),
			invalid_schema_table_msg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdb_terms.LOG_LEVELS.ERROR,
			invalid_schema_table_msg,
			true
		);
	}

	await harperBridge.dropTable(drop_table_object);

	// Purge tables local stream. Streams are part of Nats and are used by clustering, they are 'message stores' that track transactions on a table.
	await nats_utils.purgeTableStream(drop_table_object.schema, drop_table_object.table);

	let response = await replicateOperation(drop_table_object);
	response.message = `successfully deleted table '${drop_table_object.schema}.${drop_table_object.table}'`;
	return response;
}

/**
 * Drops all files for the specified attribute.
 * @param drop_attribute_object - The JSON formatted inbound message.
 * @returns {Promise<*>}
 */
async function dropAttribute(drop_attribute_object) {
	const validation = validateBySchema(
		drop_attribute_object,
		Joi.object({
			database: Joi.string(),
			schema: Joi.string(),
			table: Joi.string().required(),
			attribute: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	transformReq(drop_attribute_object);

	let invalid_schema_table_msg = await schema_metadata_validator.checkSchemaTableExists(
		drop_attribute_object.schema,
		drop_attribute_object.table
	);
	if (invalid_schema_table_msg) {
		throw handleHDBError(
			new Error(),
			invalid_schema_table_msg,
			HTTP_STATUS_CODES.NOT_FOUND,
			hdb_terms.LOG_LEVELS.ERROR,
			invalid_schema_table_msg,
			true
		);
	}

	if (
		drop_attribute_object.attribute ===
		global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table].hash_attribute
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

	if (hdb_terms.TIME_STAMP_NAMES.indexOf(drop_attribute_object.attribute) >= 0) {
		throw handleHDBError(
			new Error(),
			`cannot drop internal timestamp attribute: ${drop_attribute_object.attribute}`,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	try {
		await harperBridge.dropAttribute(drop_attribute_object);
		dropAttributeFromGlobal(drop_attribute_object);
		signalling.signalSchemaChange(
			new SchemaEventMsg(
				process.pid,
				drop_attribute_object.operation,
				drop_attribute_object.schema,
				drop_attribute_object.table,
				drop_attribute_object.attribute
			)
		);

		return `successfully deleted attribute '${drop_attribute_object.attribute}'`;
	} catch (err) {
		logger.error(`Got an error deleting attribute ${util.inspect(drop_attribute_object)}.`);
		throw err;
	}
}

/**
 * Removes the dropped attribute from the global hdb schema object.
 * @param drop_attribute_object
 */
function dropAttributeFromGlobal(drop_attribute_object) {
	let attributes_obj = Object.values(
		global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table]['attributes']
	);

	for (let i = 0; i < attributes_obj.length; i++) {
		if (attributes_obj[i].attribute === drop_attribute_object.attribute) {
			global.hdb_schema[drop_attribute_object.schema][drop_attribute_object.table]['attributes'].splice(i, 1);
		}
	}
}

async function createAttribute(create_attribute_object) {
	transformReq(create_attribute_object);

	const table_attr = getDatabases()[create_attribute_object.schema][create_attribute_object.table].attributes;
	for (const { name } of table_attr) {
		if (name === create_attribute_object.attribute) {
			throw handleHDBError(
				new Error(),
				`attribute '${create_attribute_object.attribute}' already exists in ${create_attribute_object.schema}.${create_attribute_object.table}`,
				HTTP_STATUS_CODES.BAD_REQUEST,
				undefined,
				undefined,
				true
			);
		}
	}

	await harperBridge.createAttribute(create_attribute_object);
	signalling.signalSchemaChange(
		new SchemaEventMsg(
			process.pid,
			create_attribute_object.operation,
			create_attribute_object.schema,
			create_attribute_object.table,
			create_attribute_object.attribute
		)
	);

	return `attribute '${create_attribute_object.schema}.${create_attribute_object.table}.${create_attribute_object.attribute}' successfully created.`;
}

function getBackup(get_backup_object) {
	return harperBridge.getBackup(get_backup_object);
}

function cleanupOrphanBlobs(request) {
	if (!request.database) throw new ClientError('Must provide "database" name for search for orphaned blobs');
	const database = databases[request.database];
	if (!database) throw new ClientError(`Unknown database '${request.database}'`);
	const { cleanupOrphans } = require('../resources/blob');
	// don't await, it will probably take hours
	cleanupOrphans(databases[request.database]);
	return { message: 'Orphaned blobs cleanup started, check logs for progress' };
}
