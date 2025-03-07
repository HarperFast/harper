'use strict';

//this is to avoid a circular dependency with insert.  insert needs the describe all function but so does the main schema module.  as such the functions have been broken out into a separate module.
const search = require('./search');
const logger = require('../utility/logging/harper_logger');
const validator = require('../validation/schema_validator');
const crypto_hash = require('../security/cryptoHash');
const hdb_utils = require('../utility/common_utils');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;
const env_mngr = require('../utility/environment/environmentManager');
env_mngr.initSync();
const { getDatabases } = require('../resources/databases');
const fs = require('fs-extra');
const hdb_terms = require('../utility/hdbTerms');

module.exports = {
	describeAll,
	describeTable: descTable,
	describeSchema,
};

/**
 * This method is exposed to the API and internally for system operations.  If the op is being made internally, the `op_obj`
 * argument is not passed and, therefore, no permissions are used to filter the final schema metadata results.
 * @param op_obj
 * @returns {Promise<{}|HdbError>}
 */
async function describeAll(op_obj = {}) {
	try {
		const sys_call = hdb_utils.isEmptyOrZeroLength(op_obj);
		const bypass_auth = !!op_obj.bypass_auth;
		let role_perms;
		let is_su;
		if (!sys_call && !bypass_auth) {
			role_perms = op_obj.hdb_user?.role?.permission;
			is_su = role_perms?.super_user || role_perms?.cluster_user;
		}
		let databases = getDatabases();
		let schema_list = {};
		let schema_perms = {};
		let t_results = [];
		const exact_count = op_obj?.exact_count;
		for (let schema in databases) {
			schema_list[schema] = true;
			if (!sys_call && !is_su && !bypass_auth)
				schema_perms[schema] = op_obj.hdb_user?.role?.permission[schema]?.describe;
			let tables = databases[schema];
			for (let table in tables) {
				try {
					let desc;
					if (sys_call || is_su || bypass_auth) {
						desc = await descTable({ schema, table, exact_count });
					} else if (role_perms && role_perms[schema].describe && role_perms[schema].tables[table].describe) {
						const t_attr_perms = role_perms[schema].tables[table].attribute_permissions;
						desc = await descTable({ schema, table, exact_count }, t_attr_perms);
					}
					if (desc) {
						t_results.push(desc);
					}
				} catch (e) {
					logger.error(e);
				}
			}
		}

		let hdb_description = {};
		for (let t in t_results) {
			if (sys_call || is_su || bypass_auth) {
				if (hdb_description[t_results[t].schema] == null) {
					hdb_description[t_results[t].schema] = {};
				}

				hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];
				if (schema_list[t_results[t].schema]) {
					delete schema_list[t_results[t].schema];
				}
			} else if (schema_perms[t_results[t].schema]) {
				if (hdb_description[t_results[t].schema] == null) {
					hdb_description[t_results[t].schema] = {};
				}

				hdb_description[t_results[t].schema][t_results[t].name] = t_results[t];
				if (schema_list[t_results[t].schema]) {
					delete schema_list[t_results[t].schema];
				}
			}
		}

		for (let schema in schema_list) {
			if (sys_call || is_su || bypass_auth) {
				hdb_description[schema] = {};
			} else if (schema_perms[schema]) {
				hdb_description[schema] = {};
			}
		}
		return hdb_description;
	} catch (e) {
		logger.error('Got an error in describeAll');
		logger.error(e);
		return handleHDBError(new Error(), HDB_ERROR_MSGS.DESCRIBE_ALL_ERR);
	}
}

/**
 * This method will return the metadata for a table - if `attr_perms` are passed as an argument (or included in the `describe_table_object` arg),
 * the final results w/ be filtered based on those permissions
 *
 * @param describe_table_object
 * @param attr_perms - optional - permissions for the role requesting metadata for the table used when chained to other
 * internal operations.  If this method is hit via the API, perms will be grabbed from the describe_table_object which
 * includes the users role and permissions.
 * @returns {Promise<{}|*>}
 */
async function descTable(describe_table_object, attr_perms) {
	hdb_utils.transformReq(describe_table_object);
	let { schema, table } = describe_table_object;
	schema = schema?.toString();
	table = table?.toString();
	let table_attr_perms = attr_perms;

	//If the describe_table_object includes a `hdb_user` value, it is being called from the API and we can grab the user's
	// role permissions from there
	if (describe_table_object.hdb_user && !describe_table_object.hdb_user?.role?.permission?.super_user) {
		table_attr_perms = describe_table_object.hdb_user?.role?.permission[schema]?.tables[table]?.attribute_permissions;
	}

	let validation = validator.describe_table(describe_table_object);
	if (validation) {
		throw validation;
	}

	let databases = getDatabases();
	let tables = databases[schema];
	if (!tables) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(describe_table_object.schema),
			HTTP_STATUS_CODES.NOT_FOUND
		);
	}
	let table_obj = tables[table];
	if (!table_obj)
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.TABLE_NOT_FOUND(describe_table_object.schema, describe_table_object.table),
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
	if (table_attr_perms) {
		let permitted_attr = {};
		table_attr_perms.forEach((a) => {
			if (a.describe) permitted_attr[a.attribute_name] = true;
		});

		table_obj.attributes.forEach((a) => {
			if (permitted_attr[a.name]) pushAtt(a);
		});
	} else {
		table_obj.attributes?.forEach((att) => pushAtt(att));
	}
	let db_size;
	try {
		db_size = (await fs.stat(table_obj.primaryStore.env.path)).size;
	} catch (error) {
		logger.warn(`unable to get database size`, error);
	}
	let table_result = {
		schema,
		name: table_obj.tableName,
		hash_attribute: table_obj.attributes.find((attribute) => attribute.isPrimaryKey || attribute.is_hash_attribute)
			?.name,
		audit: table_obj.audit,
		schema_defined: table_obj.schemaDefined,
		attributes,
		db_size,
	};
	if (table_obj.replicate !== undefined) table_result.replicate = table_obj.replicate;
	if (table_obj.expirationMS !== undefined) table_result.expiration = table_obj.expirationMS / 1000 + 's';
	if (table_obj.sealed !== undefined) table_result.sealed = table_obj.sealed;
	if (table_obj.sources?.length > 0)
		table_result.sources = table_obj.sources
			.map((source) => source.name)
			.filter((source) => source && source !== 'NATSReplicator' && source !== 'Replicator');
	// Nats/clustering stream names are hashed to ensure constant length alphanumeric values.
	// String will always hash to the same value.
	if (env_mngr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED))
		table_result.clustering_stream_name = crypto_hash.createNatsTableStreamName(table_result.schema, table_result.name);

	try {
		const record_count = await table_obj.getRecordCount({ exactCount: describe_table_object.exact_count === 'true' });
		table_result.record_count = record_count.recordCount;
		table_result.table_size = table_obj.getSize();
		table_result.db_audit_size = table_obj.getAuditSize();
		table_result.estimated_record_range = record_count.estimatedRange;
		let audit_store = table_obj.auditStore;
		if (audit_store) {
			for (let key of audit_store.getKeys({ reverse: true, limit: 1 })) {
				table_result.last_updated_record = key[0];
			}
		}
		if (!table_result.last_updated_record && table_obj.indices.__updatedtime__) {
			for (let key of table_obj.indices.__updatedtime__.getKeys({ reverse: true, limit: 1 })) {
				table_result.last_updated_record = key;
			}
		}
	} catch (e) {
		logger.warn(`unable to stat table dbi due to ${e}`);
	}
	return table_result;
}

/**
 * Returns the schema metadata filtered based on permissions for the user role making the request
 *
 * @param describe_schema_object
 * @returns {Promise<{}|[]>}
 */
async function describeSchema(describe_schema_object) {
	hdb_utils.transformReq(describe_schema_object);

	let validation_msg = validator.schema_object(describe_schema_object);
	if (validation_msg) {
		throw validation_msg;
	}

	let schema_perms;

	if (describe_schema_object.hdb_user && !describe_schema_object.hdb_user?.role?.permission?.super_user) {
		schema_perms = describe_schema_object.hdb_user?.role?.permission[describe_schema_object.schema];
	}
	const schema_name = describe_schema_object.schema.toString();

	let databases = getDatabases();
	let schema = databases[schema_name];
	if (!schema) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(describe_schema_object.schema),
			HTTP_STATUS_CODES.NOT_FOUND
		);
	}
	let results = {};
	for (let table_name in schema) {
		let table_perms;
		if (schema_perms && schema_perms.tables[table_name]) {
			table_perms = schema_perms.tables[table_name];
		}
		if (hdb_utils.isEmpty(table_perms) || table_perms.describe) {
			let data = await descTable(
				{ schema: describe_schema_object.schema, table: table_name, exact_count: describe_schema_object.exact_count },
				table_perms ? table_perms.attribute_permissions : null
			);
			if (data) {
				results[data.name] = data;
			}
		}
	}
	return results;
}
