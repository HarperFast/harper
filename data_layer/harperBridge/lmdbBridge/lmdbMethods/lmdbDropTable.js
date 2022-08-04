'use strict';

const SearchObject = require('../../../SearchObject');
const DeleteObject = require('../../../../data_layer/DeleteObject');
const search_by_value = require('./lmdbSearchByValue');
const delete_records = require('./lmdbDeleteRecords');
const drop_all_attributes = require('../lmdbUtility/lmdbDropAllAttributes');
const hdb_terms = require('../../../../utility/hdbTerms');
const hdb_utils = require('../../../../utility/common_utils');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const { getBaseSchemaPath, getTransactionAuditStorePath } = require('../lmdbUtility/initializePaths');
const path = require('path');
const log = require('../../../../utility/logging/harper_logger');

module.exports = lmdbDropTable;

/**
 * Calls drops the table, all of it's attribute & deletes the environment
 * @param drop_table_obj
 */
async function lmdbDropTable(drop_table_obj) {
	try {
		if (
			hdb_utils.isEmpty(global.hdb_schema[drop_table_obj.schema]) ||
			hdb_utils.isEmpty(global.hdb_schema[drop_table_obj.schema][drop_table_obj.table])
		) {
			throw new Error(`unknown schema:${drop_table_obj.schema} and table ${drop_table_obj.table}`);
		}
		await deleteAttributesFromSystem(drop_table_obj);
		await dropTableFromSystem(drop_table_obj);

		let schema_path = path.join(getBaseSchemaPath(), drop_table_obj.schema.toString());
		try {
			await environment_utility.deleteEnvironment(schema_path, drop_table_obj.table);
		} catch (e) {
			if (e.message === 'invalid environment') {
				log.warn(
					`cannot delete environment for ${drop_table_obj.schema}.${drop_table_obj.table}, environment not found`
				);
			} else {
				throw e;
			}
		}

		try {
			let transaction_path = path.join(getTransactionAuditStorePath(), drop_table_obj.schema.toString());
			await environment_utility.deleteEnvironment(transaction_path, drop_table_obj.table, true);
		} catch (e) {
			if (e.message === 'invalid environment') {
				log.warn(
					`cannot delete environment for ${drop_table_obj.schema}.${drop_table_obj.table}, environment not found`
				);
			} else {
				throw e;
			}
		}
	} catch (err) {
		throw err;
	}
}

/**
 *
 * @param drop_table_obj
 * @returns {Promise<void>}
 */
async function deleteAttributesFromSystem(drop_table_obj) {
	let search_obj = new SearchObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY,
		`${drop_table_obj.schema}.${drop_table_obj.table}`,
		undefined,
		[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]
	);

	let search_result = await search_by_value(search_obj);

	let delete_ids = [];
	for (let x = 0; x < search_result.length; x++) {
		let entry = search_result[x];
		delete_ids.push(entry.id);
	}

	if (delete_ids.length === 0) {
		return;
	}

	let delete_table_obj = new DeleteObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		delete_ids
	);

	await delete_records(delete_table_obj);
}

/**
 * Searches the system table for the table hash, then uses hash to delete table from system.
 * @param drop_table_obj
 */
async function dropTableFromSystem(drop_table_obj) {
	let search_obj = new SearchObject(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
		hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
		drop_table_obj.table,
		undefined,
		[
			hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
			hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
			hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
		]
	);
	let search_result;
	let delete_table;
	try {
		search_result = await search_by_value(search_obj);
	} catch (err) {
		throw err;
	}

	let drop_table_obj_table = hdb_utils.autoCast(drop_table_obj.table);
	let drop_table_obj_schema = hdb_utils.autoCast(drop_table_obj.schema);

	// Data found by the search function should match the drop_table_object
	for (let x = 0; x < search_result.length; x++) {
		let item = search_result[x];
		if (item.name === drop_table_obj_table && item.schema === drop_table_obj_schema) {
			delete_table = item;
		}
	}

	if (!delete_table) {
		throw new Error(`${drop_table_obj.schema}.${drop_table_obj.table} was not found`);
	}

	let delete_table_obj = new DeleteObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME, [
		delete_table.id,
	]);
	try {
		await delete_records(delete_table_obj);
	} catch (err) {
		throw err;
	}
}
