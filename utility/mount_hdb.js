'use strict';

const { mkdirpSync, copySync } = require('fs-extra');
const path = require('path');
const terms = require('../utility/hdbTerms.ts');
const { PACKAGE_ROOT } = require('../utility/packageUtils.js');
const hdbLogger = require('../utility/logging/harper_logger.js');
const bridge = require('../dataLayer/harperBridge/harperBridge.js');
const systemSchema = require('../json/systemSchema.json');
const initPaths = require('../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js');

module.exports = mountHdb;

async function mountHdb(hdbPath) {
	hdbLogger.trace('Mounting HarperDB');

	makeDirectory(hdbPath);
	makeDirectory(path.join(hdbPath, 'backup'));
	makeDirectory(path.join(hdbPath, 'keys'));
	makeDirectory(path.join(hdbPath, 'keys', terms.LICENSE_FILE_NAME));
	makeDirectory(path.join(hdbPath, 'log'));
	makeDirectory(path.join(hdbPath, 'database'));
	makeDirectory(path.join(hdbPath, 'components'));
	copySync(path.resolve(PACKAGE_ROOT, './utility/install/README.md'), path.join(hdbPath, 'README.md'));

	await createLMDBTables();
}

/**
 * creates the environments & dbis needed for lmdb  based on the systemSchema
 * @returns {Promise<void>}
 */
async function createLMDBTables() {
	// eslint-disable-next-line global-require
	const CreateTableObject = require('../dataLayer/CreateTableObject.js');

	let tables = Object.keys(systemSchema);

	for (const tableName of tables) {
		let hash_attribute = systemSchema[tableName].hash_attribute;
		try {
			initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, tableName);
			let createTable = new CreateTableObject(terms.SYSTEM_SCHEMA_NAME, tableName, hash_attribute);
			createTable.attributes = systemSchema[tableName].attributes;
			let primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === hash_attribute);
			primaryKeyAttribute.isPrimaryKey = true;

			// Array of tables to enable audit store, config file doesn't exist yet so we need to manually set which tables to audit
			if (['hdb_user', 'hdb_role'].includes(tableName)) createTable.audit = true;
			await bridge.createTable(tableName, createTable);
		} catch (e) {
			hdbLogger.error(`issue creating environment for ${terms.SYSTEM_SCHEMA_NAME}.${tableName}: ${e}`);
			throw e;
		}
	}
}

function makeDirectory(targetDir) {
	mkdirpSync(targetDir, { mode: terms.HDB_FILE_PERMISSIONS });
	hdbLogger.info(`Directory ${targetDir} created`);
}
