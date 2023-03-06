'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const env = require('../../../../utility/environment/environmentManager');
const path = require('path');
const minimist = require('minimist');
const fs = require('fs-extra');
const _ = require('lodash');
env.initSync();

const { CONFIG_PARAMS, SCHEMAS_PARAM_CONFIG, SYSTEM_SCHEMA_NAME } = hdb_terms;
let BASE_SCHEMA_PATH = undefined;
let SYSTEM_SCHEMA_PATH = undefined;
let TRANSACTION_STORE_PATH = undefined;

/**
 * when HDB is not yet installed we do not yet know the base path and an error is thrown if we do a standard const, so we create a getter
 * @returns {string|*}
 */
function getBaseSchemaPath() {
	if (BASE_SCHEMA_PATH !== undefined) {
		return BASE_SCHEMA_PATH;
	}

	if (env.getHdbBasePath() !== undefined) {
		BASE_SCHEMA_PATH =
			env.get(CONFIG_PARAMS.STORAGE_PATH) || path.join(env.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);
		return BASE_SCHEMA_PATH;
	}
}

/**
 * when HDB is not yet installed we do not yet know the base path and an error is thrown if we do a standard const, so we create a getter
 * @returns {string|*}
 */
function getSystemSchemaPath() {
	if (SYSTEM_SCHEMA_PATH !== undefined) {
		return SYSTEM_SCHEMA_PATH;
	}

	if (env.getHdbBasePath() !== undefined) {
		SYSTEM_SCHEMA_PATH = getSchemaPath(SYSTEM_SCHEMA_NAME);
		return SYSTEM_SCHEMA_PATH;
	}
}

function getTransactionAuditStoreBasePath() {
	if (TRANSACTION_STORE_PATH !== undefined) {
		return TRANSACTION_STORE_PATH;
	}

	if (env.getHdbBasePath() !== undefined) {
		TRANSACTION_STORE_PATH =
			env.get(hdb_terms.CONFIG_PARAMS.STORAGE_AUDIT_PATH) ||
			path.join(env.getHdbBasePath(), hdb_terms.TRANSACTIONS_DIR_NAME);
		return TRANSACTION_STORE_PATH;
	}
}

function getTransactionAuditStorePath(schema, table) {
	let schema_config = env.get(CONFIG_PARAMS.SCHEMAS)?.[schema];
	return (
		(table && schema_config?.tables?.[table]?.auditPath) ||
		schema_config?.auditPath ||
		path.join(getTransactionAuditStoreBasePath(), schema.toString())
	);
}

function getSchemaPath(schema, table) {
	schema = schema.toString();
	table = table ? table.toString() : table;
	let schema_config = env.get(hdb_terms.CONFIG_PARAMS.SCHEMAS)?.[schema];
	return (
		(table && schema_config?.tables?.[table]?.path) || schema_config?.path || path.join(getBaseSchemaPath(), schema)
	);
}

/**
 * It is possible to set where the system schema/table files reside. This function will check for CLI/env vars
 * on install and update accordingly.
 * @param schema
 * @param table
 * @returns {string|string|*}
 */
function initSystemSchemaPaths(schema, table) {
	schema = schema.toString();
	table = table.toString();

	// Check to see if there are any CLI or env args related to schema/table path
	const args = process.env;
	Object.assign(args, minimist(process.argv));

	const schema_conf_json = args[CONFIG_PARAMS.SCHEMAS.toUpperCase()];
	if (schema_conf_json) {
		let schemas_conf;
		try {
			schemas_conf = JSON.parse(schema_conf_json);
		} catch (err) {
			if (!hdb_utils.isObject(schema_conf_json)) throw err;
			schemas_conf = schema_conf_json;
		}

		for (const schema_conf of schemas_conf) {
			const system_schema_conf = schema_conf[SYSTEM_SCHEMA_NAME];
			if (!system_schema_conf) continue;
			let schemas_obj = env.get(CONFIG_PARAMS.SCHEMAS);
			schemas_obj = schemas_obj ?? {};

			// If path var exists for system table add it to schemas prop and return path.
			const system_table_path = system_schema_conf?.tables?.[table]?.[SCHEMAS_PARAM_CONFIG.PATH];
			if (system_table_path) {
				_.set(
					schemas_obj,
					[SYSTEM_SCHEMA_NAME, SCHEMAS_PARAM_CONFIG.TABLES, table, SCHEMAS_PARAM_CONFIG.PATH],
					system_table_path
				);
				env.setProperty(CONFIG_PARAMS.SCHEMAS, schemas_obj);
				return system_table_path;
			}

			// If path exists for system schema add it to schemas prop and return path.
			const system_schema_path = system_schema_conf?.[SCHEMAS_PARAM_CONFIG.PATH];
			if (system_schema_path) {
				_.set(schemas_obj, [SYSTEM_SCHEMA_NAME, SCHEMAS_PARAM_CONFIG.PATH], system_schema_path);
				env.setProperty(CONFIG_PARAMS.SCHEMAS, schemas_obj);
				return system_schema_path;
			}
		}
	}

	// If storage_path is passed use that to determine location
	const storage_path = args[CONFIG_PARAMS.STORAGE_PATH.toUpperCase()];
	if (storage_path) {
		if (!fs.pathExistsSync(storage_path)) throw new Error(storage_path + ' does not exist');
		const storage_schema_path = path.join(storage_path, schema);
		fs.mkdirsSync(storage_schema_path);
		env.setProperty(CONFIG_PARAMS.STORAGE_PATH, storage_path);

		return storage_schema_path;
	}

	// Default to default location
	return getSystemSchemaPath();
}
function resetPaths() {
	BASE_SCHEMA_PATH = undefined;
	SYSTEM_SCHEMA_PATH = undefined;
	TRANSACTION_STORE_PATH = undefined;
}
module.exports = {
	getBaseSchemaPath,
	getSystemSchemaPath,
	getTransactionAuditStorePath,
	getTransactionAuditStoreBasePath,
	getSchemaPath,
	initSystemSchemaPaths,
	resetPaths
};
