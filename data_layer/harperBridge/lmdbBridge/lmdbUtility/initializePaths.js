'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const env = require('../../../../utility/environment/environmentManager');
const path = require('path');
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
		BASE_SCHEMA_PATH = env.get(hdb_terms.CONFIG_PARAMS.STORAGE_PATH) ||
			path.join(env.getHdbBasePath(), hdb_terms.SCHEMA_DIR_NAME);
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
		TRANSACTION_STORE_PATH = env.get(hdb_terms.CONFIG_PARAMS.STORAGE_AUDIT_PATH) ||
			path.join(env.getHdbBasePath(), hdb_terms.TRANSACTIONS_DIR_NAME);
		return TRANSACTION_STORE_PATH;
	}
}

function getTransactionAuditStorePath(schema, table) {
	let schema_config = env.get(hdb_terms.CONFIG_PARAMS.SCHEMAS)?.[schema];
	return (table && schema_config?.tables?.[table]?.auditPath) || schema_config?.auditPath ||
		path.join(getTransactionAuditStoreBasePath(), schema.toString());
}

function getSchemaPath(schema, table) {
	let schema_config = env.get(hdb_terms.CONFIG_PARAMS.SCHEMAS)?.[schema];
	return (table && schema_config?.tables?.[table]?.path) || schema_config?.path ||
		path.join(getBaseSchemaPath(), schema.toString());
}

module.exports = {
	getBaseSchemaPath,
	getSystemSchemaPath,
	getTransactionAuditStorePath,
	getSchemaPath,
};
