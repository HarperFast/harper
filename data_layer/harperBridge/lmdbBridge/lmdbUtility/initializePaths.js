'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const env = require('../../../../utility/environment/environmentManager');
const path = require('path');
const minimist = require('minimist');
const fs = require('fs-extra');
env.initSync();

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
			env.get(hdb_terms.CONFIG_PARAMS.STORAGE_PATH) || path.join(env.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);
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
		SYSTEM_SCHEMA_PATH = getSchemaPath(hdb_terms.SYSTEM_SCHEMA_NAME);
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
	let schema_config = env.get(hdb_terms.CONFIG_PARAMS.SCHEMAS)?.[schema];
	return (
		(table && schema_config?.tables?.[table]?.auditPath) ||
		schema_config?.auditPath ||
		path.join(getTransactionAuditStoreBasePath(), schema.toString())
	);
}

function getSchemaPath(schema, table) {
	// Check to see if there are any CLI or env args related to schema/table path
	const args = process.env;
	Object.assign(args, minimist(process.argv));
	const schema_uc = schema.toUpperCase();
	const table_uc = table ? table.toUpperCase() : undefined;
	schema = schema.toString();

	const schema_table_path = args[`SCHEMA_${schema_uc}_TABLES_${table_uc}_PATH`];
	if (schema_table_path) {
		checkPathExists(schema_table_path);
		return schema_table_path;
	}

	const schema_path = args[`SCHEMA_${schema_uc}_PATH`];
	if (schema_path) {
		checkPathExists(schema_path);
		return schema_path;
	}

	const storage_path = args['STORAGE_PATH'];
	if (storage_path) {
		checkPathExists(storage_path);
		const storage_schema_path = path.join(args['STORAGE_PATH'], schema);
		fs.mkdirsSync(storage_schema_path);
		return storage_schema_path;
	}

	let schema_config = env.get(hdb_terms.CONFIG_PARAMS.SCHEMAS)?.[schema];
	return (
		(table && schema_config?.tables?.[table]?.path) || schema_config?.path || path.join(getBaseSchemaPath(), schema)
	);
}

function checkPathExists(storage_path) {
	if (!fs.pathExistsSync(storage_path)) throw new Error(storage_path + ' does not exist');
}

module.exports = {
	getBaseSchemaPath,
	getSystemSchemaPath,
	getTransactionAuditStorePath,
	getSchemaPath,
};
