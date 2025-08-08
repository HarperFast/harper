'use strict';

const { mkdirpSync, copySync } = require('fs-extra');
const path = require('path');
const terms = require('../utility/hdbTerms');
const { PACKAGE_ROOT } = require('../utility/packageUtils');
const hdb_logger = require('../utility/logging/harper_logger');
const bridge = require('../dataLayer/harperBridge/harperBridge');
const system_schema = require('../json/systemSchema');
const init_paths = require('../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');

module.exports = mountHdb;

async function mountHdb(hdb_path) {
	hdb_logger.trace('Mounting HarperDB');

	makeDirectory(hdb_path);
	makeDirectory(path.join(hdb_path, 'backup'));
	makeDirectory(path.join(hdb_path, 'keys'));
	makeDirectory(path.join(hdb_path, 'keys', terms.LICENSE_FILE_NAME));
	makeDirectory(path.join(hdb_path, 'log'));
	makeDirectory(path.join(hdb_path, 'database'));
	makeDirectory(path.join(hdb_path, 'components'));
	copySync(path.resolve(PACKAGE_ROOT, './utility/install/README.md'), path.join(hdb_path, 'README.md'));

	await createLMDBTables();
}

/**
 * creates the environments & dbis needed for lmdb  based on the systemSchema
 * @returns {Promise<void>}
 */
async function createLMDBTables() {
	// eslint-disable-next-line global-require
	const CreateTableObject = require('../dataLayer/CreateTableObject');

	let tables = Object.keys(system_schema);

	for (let x = 0; x < tables.length; x++) {
		let table_name = tables[x];
		let hash_attribute = system_schema[table_name].hash_attribute;
		try {
			init_paths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, table_name);
			let create_table = new CreateTableObject(terms.SYSTEM_SCHEMA_NAME, table_name, hash_attribute);
			create_table.attributes = system_schema[table_name].attributes;
			let primary_key_attribute = create_table.attributes.find(({ attribute }) => attribute === hash_attribute);
			primary_key_attribute.isPrimaryKey = true;

			// Array of tables to enable audit store, config file doesn't exist yet so we need to manually set which tables to audit
			if (['hdb_user', 'hdb_role', 'hdb_nodes'].includes(table_name)) create_table.audit = true;
			await bridge.createTable(table_name, create_table);
		} catch (e) {
			hdb_logger.error(`issue creating environment for ${terms.SYSTEM_SCHEMA_NAME}.${table_name}: ${e}`);
			throw e;
		}
	}
}

function makeDirectory(targetDir) {
	mkdirpSync(targetDir, { mode: terms.HDB_FILE_PERMISSIONS });
	hdb_logger.info(`Directory ${targetDir} created`);
}
