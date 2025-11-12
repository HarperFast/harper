'use strict';

const hdbTerms = require('../../../../utility/hdbTerms.ts');
const hdbUtils = require('../../../../utility/common_utils.js');
const env = require('../../../../utility/environment/environmentManager.js');
const path = require('path');
const minimist = require('minimist');
const fs = require('fs-extra');
const _ = require('lodash');
env.initSync();

const { CONFIG_PARAMS, DATABASES_PARAM_CONFIG, SYSTEM_SCHEMA_NAME } = hdbTerms;
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
			env.get(CONFIG_PARAMS.STORAGE_PATH) || path.join(env.getHdbBasePath(), hdbTerms.DATABASES_DIR_NAME);
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
			env.get(hdbTerms.CONFIG_PARAMS.STORAGE_AUDIT_PATH) ||
			path.join(env.getHdbBasePath(), hdbTerms.TRANSACTIONS_DIR_NAME);
		return TRANSACTION_STORE_PATH;
	}
}

function getTransactionAuditStorePath(schema, table) {
	let schemaConfig = env.get(CONFIG_PARAMS.DATABASES)?.[schema];
	return (
		(table && schemaConfig?.tables?.[table]?.auditPath) ||
		schemaConfig?.auditPath ||
		path.join(getTransactionAuditStoreBasePath(), schema.toString())
	);
}

function getSchemaPath(schema, table) {
	schema = schema.toString();
	table = table ? table.toString() : table;
	let schemaConfig = env.get(hdbTerms.CONFIG_PARAMS.DATABASES)?.[schema];
	return (table && schemaConfig?.tables?.[table]?.path) || schemaConfig?.path || path.join(getBaseSchemaPath(), schema);
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

	const schemaConfJson = args[CONFIG_PARAMS.DATABASES.toUpperCase()];
	if (schemaConfJson) {
		let schemasConf;
		try {
			schemasConf = JSON.parse(schemaConfJson);
		} catch (err) {
			if (!hdbUtils.isObject(schemaConfJson)) throw err;
			schemasConf = schemaConfJson;
		}

		for (const schemaConf of schemasConf) {
			const systemSchemaConf = schemaConf[SYSTEM_SCHEMA_NAME];
			if (!systemSchemaConf) continue;
			let schemasObj = env.get(CONFIG_PARAMS.DATABASES);
			schemasObj = schemasObj ?? {};

			// If path var exists for system table add it to schemas prop and return path.
			const systemTablePath = systemSchemaConf?.tables?.[table]?.[DATABASES_PARAM_CONFIG.PATH];
			if (systemTablePath) {
				_.set(
					schemasObj,
					[SYSTEM_SCHEMA_NAME, DATABASES_PARAM_CONFIG.TABLES, table, DATABASES_PARAM_CONFIG.PATH],
					systemTablePath
				);
				env.setProperty(CONFIG_PARAMS.DATABASES, schemasObj);
				return systemTablePath;
			}

			// If path exists for system schema add it to schemas prop and return path.
			const systemSchemaPath = systemSchemaConf?.[DATABASES_PARAM_CONFIG.PATH];
			if (systemSchemaPath) {
				_.set(schemasObj, [SYSTEM_SCHEMA_NAME, DATABASES_PARAM_CONFIG.PATH], systemSchemaPath);
				env.setProperty(CONFIG_PARAMS.DATABASES, schemasObj);
				return systemSchemaPath;
			}
		}
	}

	// If storagePath is passed use that to determine location
	const storagePath = args[CONFIG_PARAMS.STORAGE_PATH.toUpperCase()];
	if (storagePath) {
		if (!fs.pathExistsSync(storagePath)) throw new Error(storagePath + ' does not exist');
		const storageSchemaPath = path.join(storagePath, schema);
		fs.mkdirsSync(storageSchemaPath);
		env.setProperty(CONFIG_PARAMS.STORAGE_PATH, storagePath);

		return storageSchemaPath;
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
	resetPaths,
};
