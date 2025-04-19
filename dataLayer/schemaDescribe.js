'use strict';

//this is to avoid a circular dependency with insert.  insert needs the describe all function but so does the main schema module.  as such the functions have been broken out into a separate module.
const search = require('./search.js');
const logger = require('../utility/logging/harper_logger.js');
const { validateBySchema } = require('../validation/validationWrapper.js');
const Joi = require('joi');
const cryptoHash = require('../security/cryptoHash.js');
const hdbUtils = require('../utility/common_utils.js');
const { handleHDBError, hdbErrors, ClientError } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const envMngr = require('../utility/environment/environmentManager.js');
envMngr.initSync();
const { getDatabases } = require('../resources/databases.ts');
const fs = require('fs-extra');
const hdbTerms = require('../utility/hdbTerms.ts');

module.exports = {
	describeAll,
	describeTable: descTable,
	describeSchema,
};

/**
 * This method is exposed to the API and internally for system operations.  If the op is being made internally, the `opObj`
 * argument is not passed and, therefore, no permissions are used to filter the final schema metadata results.
 * @param opObj
 * @returns {Promise<{}|HdbError>}
 */
async function describeAll(opObj = {}) {
	try {
		const sysCall = hdbUtils.isEmptyOrZeroLength(opObj);
		const bypassAuth = !!opObj.bypass_auth;
		let rolePerms;
		let isSu;
		if (!sysCall && !bypassAuth) {
			rolePerms = opObj.hdb_user?.role?.permission;
			isSu = rolePerms?.super_user || rolePerms?.cluster_user;
		}
		let databases = getDatabases();
		let schemaList = {};
		let schemaPerms = {};
		let tResults = [];
		const exactCount = opObj?.exact_count;
		for (let schema in databases) {
			schemaList[schema] = true;
			if (!sysCall && !isSu && !bypassAuth)
				schemaPerms[schema] = opObj.hdb_user?.role?.permission[schema]?.describe;
			let tables = databases[schema];
			for (let table in tables) {
				try {
					let desc;
					if (sysCall || isSu || bypassAuth) {
						desc = await descTable({ schema, table, exactCount });
					} else if (rolePerms && rolePerms[schema].describe && rolePerms[schema].tables[table].describe) {
						const tAttrPerms = rolePerms[schema].tables[table].attribute_permissions;
						desc = await descTable({ schema, table, exactCount }, tAttrPerms);
					}
					if (desc) {
						tResults.push(desc);
					}
				} catch (e) {
					logger.error(e);
				}
			}
		}

		let hdbDescription = {};
		for (let t in tResults) {
			if (sysCall || isSu || bypassAuth) {
				if (hdbDescription[tResults[t].schema] == null) {
					hdbDescription[tResults[t].schema] = {};
				}

				hdbDescription[tResults[t].schema][tResults[t].name] = tResults[t];
				if (schemaList[tResults[t].schema]) {
					delete schemaList[tResults[t].schema];
				}
			} else if (schemaPerms[tResults[t].schema]) {
				if (hdbDescription[tResults[t].schema] == null) {
					hdbDescription[tResults[t].schema] = {};
				}

				hdbDescription[tResults[t].schema][tResults[t].name] = tResults[t];
				if (schemaList[tResults[t].schema]) {
					delete schemaList[tResults[t].schema];
				}
			}
		}

		for (let schema in schemaList) {
			if (sysCall || isSu || bypassAuth) {
				hdbDescription[schema] = {};
			} else if (schemaPerms[schema]) {
				hdbDescription[schema] = {};
			}
		}
		return hdbDescription;
	} catch (e) {
		logger.error('Got an error in describeAll');
		logger.error(e);
		return handleHDBError(new Error(), HDB_ERROR_MSGS.DESCRIBE_ALL_ERR);
	}
}

/**
 * This method will return the metadata for a table - if `attrPerms` are passed as an argument (or included in the `describeTableObject` arg),
 * the final results w/ be filtered based on those permissions
 *
 * @param describeTableObject
 * @param attrPerms - optional - permissions for the role requesting metadata for the table used when chained to other
 * internal operations.  If this method is hit via the API, perms will be grabbed from the describeTableObject which
 * includes the users role and permissions.
 * @returns {Promise<{}|*>}
 */
async function descTable(describeTableObject, attrPerms) {
	hdbUtils.transformReq(describeTableObject);
	let { schema, table } = describeTableObject;
	schema = schema?.toString();
	table = table?.toString();
	let tableAttrPerms = attrPerms;

	//If the describeTableObject includes a `hdb_user` value, it is being called from the API and we can grab the user's
	// role permissions from there
	if (describeTableObject.hdb_user && !describeTableObject.hdb_user?.role?.permission?.super_user) {
		tableAttrPerms = describeTableObject.hdb_user?.role?.permission[schema]?.tables[table]?.attribute_permissions;
	}

	const validation = validateBySchema(
		describeTableObject,
		Joi.object({
			database: Joi.string(),
			table: Joi.string().required(),
			exact_count: Joi.boolean().strict(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	let databases = getDatabases();
	let tables = databases[schema];
	if (!tables) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(describeTableObject.schema),
			HTTP_STATUS_CODES.NOT_FOUND
		);
	}
	let tableObj = tables[table];
	if (!tableObj)
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.TABLE_NOT_FOUND(describeTableObject.schema, describeTableObject.table),
			HTTP_STATUS_CODES.NOT_FOUND
		);

	function pushAtt(att) {
		attributes.push({
			attribute: att.attribute,
			type: att.type,
			elements: att.elements?.type,
			indexed: att.indexed,
			is_primary_key: att.isPrimaryKey,
			assigned_created_time: att.assignCreatedTime,
			assigned_updated_time: att.assignUpdatedTime,
			nullable: att.nullable,
			properties: att.properties
				? att.properties.map((prop) => {
						return { type: prop.type, name: prop.name };
					})
				: undefined,
		});
	}

	let attributes = [];
	if (tableAttrPerms) {
		let permittedAttr = {};
		tableAttrPerms.forEach((a) => {
			if (a.describe) permittedAttr[a.attribute_name] = true;
		});

		tableObj.attributes.forEach((a) => {
			if (permittedAttr[a.name]) pushAtt(a);
		});
	} else {
		tableObj.attributes?.forEach((att) => pushAtt(att));
	}
	let db_size;
	try {
		db_size = (await fs.stat(tableObj.primaryStore.env.path)).size;
	} catch (error) {
		logger.warn(`unable to get database size`, error);
	}
	let tableResult = {
		schema,
		name: tableObj.tableName,
		hash_attribute: tableObj.attributes.find((attribute) => attribute.isPrimaryKey || attribute.is_hash_attribute)
			?.name,
		audit: tableObj.audit,
		schema_defined: tableObj.schemaDefined,
		attributes,
		db_size,
	};
	if (tableObj.replicate !== undefined) tableResult.replicate = tableObj.replicate;
	if (tableObj.expirationMS !== undefined) tableResult.expiration = tableObj.expirationMS / 1000 + 's';
	if (tableObj.sealed !== undefined) tableResult.sealed = tableObj.sealed;
	if (tableObj.sources?.length > 0)
		tableResult.sources = tableObj.sources
			.map((source) => source.name)
			.filter((source) => source && source !== 'NATSReplicator' && source !== 'Replicator');
	// Nats/clustering stream names are hashed to ensure constant length alphanumeric values.
	// String will always hash to the same value.
	if (envMngr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED))
		tableResult.clustering_stream_name = cryptoHash.createNatsTableStreamName(tableResult.schema, tableResult.name);

	try {
		const recordCount = await tableObj.getRecordCount({ exactCount: !!describeTableObject.exact_count });
		tableResult.record_count = recordCount.recordCount;
		tableResult.table_size = tableObj.getSize();
		tableResult.db_audit_size = tableObj.getAuditSize();
		tableResult.estimated_record_range = recordCount.estimatedRange;
		let auditStore = tableObj.auditStore;
		if (auditStore) {
			for (let key of auditStore.getKeys({ reverse: true, limit: 1 })) {
				tableResult.last_updated_record = key[0];
			}
		}
		if (!tableResult.last_updated_record && tableObj.indices.__updatedtime__) {
			for (let key of tableObj.indices.__updatedtime__.getKeys({ reverse: true, limit: 1 })) {
				tableResult.last_updated_record = key;
			}
		}
	} catch (e) {
		logger.warn(`unable to stat table dbi due to ${e}`);
	}
	return tableResult;
}

/**
 * Returns the schema metadata filtered based on permissions for the user role making the request
 *
 * @param describeSchemaObject
 * @returns {Promise<{}|[]>}
 */
async function describeSchema(describeSchemaObject) {
	hdbUtils.transformReq(describeSchemaObject);

	const validation = validateBySchema(
		describeSchemaObject,
		Joi.object({
			database: Joi.string(),
			exact_count: Joi.boolean().strict(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	let schemaPerms;

	if (describeSchemaObject.hdb_user && !describeSchemaObject.hdb_user?.role?.permission?.super_user) {
		schemaPerms = describeSchemaObject.hdb_user?.role?.permission[describeSchemaObject.schema];
	}
	const schemaName = describeSchemaObject.schema.toString();

	let databases = getDatabases();
	let schema = databases[schemaName];
	if (!schema) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(describeSchemaObject.schema),
			HTTP_STATUS_CODES.NOT_FOUND
		);
	}
	let results = {};
	for (let tableName in schema) {
		let table_perms;
		if (schemaPerms && schemaPerms.tables[tableName]) {
			table_perms = schemaPerms.tables[tableName];
		}
		if (hdbUtils.isEmpty(table_perms) || table_perms.describe) {
			let data = await descTable(
				{ schema: describeSchemaObject.schema, table: tableName, exact_count: describeSchemaObject.exact_count },
				table_perms ? table_perms.attribute_permissions : null
			);
			if (data) {
				results[data.name] = data;
			}
		}
	}
	return results;
}
