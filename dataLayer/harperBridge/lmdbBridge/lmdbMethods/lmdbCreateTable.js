'use strict';

const hdb_terms = require('../../../../utility/hdbTerms');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const write_utility = require('../../../../utility/lmdb/writeUtility');
const { getSystemSchemaPath, getSchemaPath } = require('../lmdbUtility/initializePaths');
const system_schema = require('../../../../json/systemSchema');
const lmdb_create_attribute = require('./lmdbCreateAttribute');
const LMDBCreateAttributeObject = require('../lmdbUtility/LMDBCreateAttributeObject');
const log = require('../../../../utility/logging/harper_logger');
const create_txn_environments = require('../lmdbUtility/lmdbCreateTransactionsAuditEnvironment');

module.exports = lmdbCreateTable;

/**
 * Writes new table data to the system tables creates the enivronment file and creates two datastores to track created and updated
 * timestamps for new table data.
 * @param table_system_data
 * @param table_create_obj
 */
async function lmdbCreateTable(table_system_data, table_create_obj) {
	let schema_path = getSchemaPath(table_create_obj.schema, table_create_obj.table);

	let created_time_attr = new LMDBCreateAttributeObject(
		table_create_obj.schema,
		table_create_obj.table,
		hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME,
		undefined,
		true
	);
	let updated_time_attr = new LMDBCreateAttributeObject(
		table_create_obj.schema,
		table_create_obj.table,
		hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME,
		undefined,
		true
	);
	let hash_attr = new LMDBCreateAttributeObject(
		table_create_obj.schema,
		table_create_obj.table,
		table_create_obj.hash_attribute,
		undefined,
		false,
		true
	);

	try {
		//create the new environment
		await environment_utility.createEnvironment(schema_path, table_create_obj.table);

		if (table_system_data !== undefined) {
			let hdb_table_env = await environment_utility.openEnvironment(
				getSystemSchemaPath(),
				hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME
			);

			//add the meta data to system.hdb_table
			await write_utility.insertRecords(hdb_table_env, HDB_TABLE_INFO.hash_attribute, hdb_table_attributes, [
				table_system_data,
			]);
			//create attributes for hash attribute created/updated time stamps
			created_time_attr.skip_table_check = true;
			updated_time_attr.skip_table_check = true;
			hash_attr.skip_table_check = true;

			await createAttribute(created_time_attr);
			await createAttribute(updated_time_attr);
			await createAttribute(hash_attr);
		}

		await create_txn_environments(table_create_obj);
	} catch (e) {
		throw e;
	}
}

/**
 * used to individually create the required attributes for a new table, logs a warning if any fail
 * @param {LMDBCreateAttributeObject} attribute_object
 * @returns {Promise<void>}
 */
async function createAttribute(attribute_object) {
	try {
		await lmdb_create_attribute(attribute_object);
	} catch (e) {
		log.warn(`failed to create attribute ${attribute_object.attribute} due to ${e.message}`);
	}
}
