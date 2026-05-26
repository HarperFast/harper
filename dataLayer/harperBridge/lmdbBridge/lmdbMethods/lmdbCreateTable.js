'use strict';

const hdbTerms = require('../../../../utility/hdbTerms.ts');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.ts');
const writeUtility = require('../../../../utility/lmdb/writeUtility.ts');
const { getSystemSchemaPath, getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const lmdbCreateAttribute = require('./lmdbCreateAttribute.js');
const LMDBCreateAttributeObject =
	require('../lmdbUtility/LMDBCreateAttributeObject.js').default ||
	require('../lmdbUtility/LMDBCreateAttributeObject.js');
const log = require('../../../../utility/logging/harper_logger.ts');
const createTxnEnvironments = require('../lmdbUtility/lmdbCreateTransactionsAuditEnvironment.js');

module.exports = lmdbCreateTable;

/**
 * Writes new table data to the system tables creates the environment file and creates two datastores to track created and updated
 * timestamps for new table data.
 * @param tableSystemData
 * @param tableCreateObj
 */
async function lmdbCreateTable(tableSystemData, tableCreateObj) {
	let schemaPath = getSchemaPath(tableCreateObj.schema, tableCreateObj.table);

	let createdTimeAttr = new LMDBCreateAttributeObject(
		tableCreateObj.schema,
		tableCreateObj.table,
		hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME,
		undefined,
		true
	);
	let updatedTimeAttr = new LMDBCreateAttributeObject(
		tableCreateObj.schema,
		tableCreateObj.table,
		hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME,
		undefined,
		true
	);
	let hashAttr = new LMDBCreateAttributeObject(
		tableCreateObj.schema,
		tableCreateObj.table,
		tableCreateObj.hash_attribute,
		undefined,
		false,
		true
	);

	try {
		//create the new environment
		await environmentUtility.createEnvironment(schemaPath, tableCreateObj.table);

		if (tableSystemData !== undefined) {
			let hdbTableEnv = await environmentUtility.openEnvironment(
				getSystemSchemaPath(),
				hdbTerms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME
			);

			//add the meta data to system.hdb_table
			await writeUtility.insertRecords(
				hdbTableEnv,
				// I'm not sure what else to do with these for now, but I do want to eslint to check the rest of the codebase
				// for undefined vars. - WSM 2025-11-26
				// eslint-disable-next-line no-undef
				HDB_TABLE_INFO.hash_attribute,
				// eslint-disable-next-line no-undef
				hdbTableAttributes,
				[tableSystemData]
			);
			//create attributes for hash attribute created/updated time stamps
			createdTimeAttr.skip_table_check = true;
			updatedTimeAttr.skip_table_check = true;
			hashAttr.skip_table_check = true;

			await createAttribute(createdTimeAttr);
			await createAttribute(updatedTimeAttr);
			await createAttribute(hashAttr);
		}

		await createTxnEnvironments(tableCreateObj);
	} catch (e) {
		throw e;
	}
}

/**
 * used to individually create the required attributes for a new table, logs a warning if any fail
 * @param {LMDBCreateAttributeObject} attributeObject
 * @returns {Promise<void>}
 */
async function createAttribute(attributeObject) {
	try {
		await lmdbCreateAttribute(attributeObject);
	} catch (e) {
		log.warn(`failed to create attribute ${attributeObject.attribute} due to ${e.message}`);
	}
}
