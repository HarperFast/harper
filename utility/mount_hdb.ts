'use strict';

const { mkdirpSync, copySync } = require('fs-extra');
import * as path from 'path';
import * as terms from '../utility/hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import bridge from '../dataLayer/harperBridge/harperBridge.ts';
import systemSchema from '../json/systemSchema.json';
import * as initPaths from '../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths.js';
import { PACKAGE_ROOT } from '../utility/packageUtils.js';

export default async function mountHdb(hdbPath: string) {
	hdbLogger.trace('Mounting Harper');

	makeDirectory(hdbPath);
	makeDirectory(path.join(hdbPath, 'backup'));
	makeDirectory(path.join(hdbPath, 'keys'));
	makeDirectory(path.join(hdbPath, 'log'));
	makeDirectory(path.join(hdbPath, 'database'));
	makeDirectory(path.join(hdbPath, 'components'));
	copySync(path.join(PACKAGE_ROOT, 'static/README.md'), path.join(hdbPath, 'README.md'));

	await createTables();
}

/**
 * creates the environments & dbis needed for lmdb  based on the systemSchema
 * @returns {Promise<void>}
 */
async function createTables() {
	const CreateTableObject =
		require('../dataLayer/CreateTableObject').default || require('../dataLayer/CreateTableObject');

	let tables = Object.keys(systemSchema);

	for (const tableName of tables) {
		let hash_attribute = (systemSchema as any)[tableName].hash_attribute;
		try {
			initPaths.initSystemSchemaPaths(terms.SYSTEM_SCHEMA_NAME, tableName);
			let createTable = new (CreateTableObject as any)(terms.SYSTEM_SCHEMA_NAME, tableName, hash_attribute);
			createTable.attributes = (systemSchema as any)[tableName].attributes;
			let primaryKeyAttribute = createTable.attributes.find(({ attribute }) => attribute === hash_attribute);
			primaryKeyAttribute.isPrimaryKey = true;

			// with RocksDB at least, we need to audit everything or there will be lost data
			createTable.audit = true;
			await bridge.createTable(tableName, createTable);
		} catch (e) {
			hdbLogger.error(`issue creating environment for ${terms.SYSTEM_SCHEMA_NAME}.${tableName}: ${e}`);
			throw e;
		}
	}
}

function makeDirectory(targetDir: string) {
	mkdirpSync(targetDir, { mode: terms.HDB_FILE_PERMISSIONS });
	hdbLogger.info(`Directory ${targetDir} created`);
}
