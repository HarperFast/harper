'use strict';

const fs = require('fs');
const path = require('path');
const terms = require('../utility/hdbTerms');
const hdb_logger = require('../utility/logging/harper_logger');
const lmdb_environment_utility = require('../utility/lmdb/environmentUtility');
const system_schema = require('../json/systemSchema');
const init_paths = require('../data_layer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');

module.exports = mountHdb;

async function mountHdb(hdb_path) {
	hdb_logger.trace('Mounting HarperDB');
	let system_schema_path = path.join(hdb_path, terms.SCHEMA_DIR_NAME, terms.SYSTEM_SCHEMA_NAME);

	makeDirectory(hdb_path);
	makeDirectory(path.join(hdb_path, 'backup'));
	makeDirectory(path.join(hdb_path, 'trash'));
	makeDirectory(path.join(hdb_path, 'keys'));
	makeDirectory(path.join(hdb_path, 'keys', terms.LICENSE_FILE_NAME));
	makeDirectory(path.join(hdb_path, 'log'));
	makeDirectory(path.join(hdb_path, 'doc'));
	makeDirectory(path.join(hdb_path, 'schema'));
	makeDirectory(system_schema_path);
	makeDirectory(path.join(hdb_path, terms.TRANSACTIONS_DIR_NAME));
	makeDirectory(path.join(hdb_path, 'clustering', 'leaf'));
	makeDirectory(path.join(hdb_path, 'custom_functions'));

	await createLMDBTables();
}

/**
 * creates the environments & dbis needed for lmdb  based on the systemSchema
 * @returns {Promise<void>}
 */
async function createLMDBTables() {
	// eslint-disable-next-line global-require
	let lmdb_create_table;
	// eslint-disable-next-line global-require
	const CreateTableObject = require('../data_layer/CreateTableObject');

	let tables = Object.keys(system_schema);

	for (let x = 0; x < tables.length; x++) {
		let table_name = tables[x];
		let table_env;
		let hash_attribute = system_schema[table_name].hash_attribute;
		try {
			const schema_path = init_paths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, table_name);
			lmdb_create_table =
				lmdb_create_table ?? require('../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
			let create_table = new CreateTableObject(terms.SYSTEM_SCHEMA_NAME, table_name, hash_attribute);
			await lmdb_create_table(undefined, create_table);
			table_env = await lmdb_environment_utility.openEnvironment(schema_path, table_name);
		} catch (e) {
			hdb_logger.error(`issue creating environment for ${terms.SYSTEM_SCHEMA_NAME}.${table_name}: ${e}`);
			throw e;
		}

		//create all dbis
		let attributes = system_schema[table_name].attributes;
		for (let y = 0; y < attributes.length; y++) {
			let attribute_name = attributes[y].attribute;
			try {
				if (terms.TIME_STAMP_NAMES.indexOf(attribute_name) >= 0) {
					await lmdb_environment_utility.createDBI(table_env, attribute_name, true);
				} else if (attribute_name === hash_attribute) {
					await lmdb_environment_utility.createDBI(table_env, attribute_name, false, true);
				} else {
					await lmdb_environment_utility.createDBI(table_env, attribute_name, true, false);
				}
			} catch (e) {
				hdb_logger.error(`issue creating dbi for ${terms.SYSTEM_SCHEMA_NAME}.${table_name}.${attribute_name}: ${e}`);
				throw e;
			}
		}
	}
}

function makeDirectory(targetDir, { isRelativeToScript = false } = {}) {
	const sep = path.sep;
	const initDir = path.isAbsolute(targetDir) ? sep : '';
	const baseDir = isRelativeToScript ? __dirname : '.';

	targetDir.split('/').reduce((parentDir, childDir) => {
		const curDir = path.resolve(baseDir, parentDir, childDir);
		try {
			if (curDir && curDir !== '/') {
				fs.mkdirSync(curDir, { mode: terms.HDB_FILE_PERMISSIONS });
				hdb_logger.info(`Directory ${curDir} created`);
			}
		} catch (err) {
			if (err.code !== 'EEXIST') {
				throw err;
			}
		}
		return curDir;
	}, initDir);
}
