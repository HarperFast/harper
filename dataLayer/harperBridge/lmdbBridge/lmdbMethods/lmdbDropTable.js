'use strict';

const SearchObject = require('../../../SearchObject.js');
const DeleteObject = require('../../../DeleteObject.js');
const searchByValue = require('./lmdbSearchByValue.js');
const deleteRecords = require('./lmdbDeleteRecords.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const hdbUtils = require('../../../../utility/common_utils.js');
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const { getTransactionAuditStorePath, getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const log = require('../../../../utility/logging/harper_logger.js');

module.exports = lmdbDropTable;

/**
 * Calls drops the table, all of it's attribute & deletes the environment
 * @param dropTableObj
 */
async function lmdbDropTable(dropTableObj) {
	try {
		if (
			hdbUtils.isEmpty(global.hdb_schema[dropTableObj.schema]) ||
			hdbUtils.isEmpty(global.hdb_schema[dropTableObj.schema][dropTableObj.table])
		) {
			throw new Error(`unknown schema:${dropTableObj.schema} and table ${dropTableObj.table}`);
		}
		await deleteAttributesFromSystem(dropTableObj);
		await dropTableFromSystem(dropTableObj);

		let schemaPath = getSchemaPath(dropTableObj.schema, dropTableObj.table);
		try {
			await environmentUtility.deleteEnvironment(schemaPath, dropTableObj.table);
		} catch (e) {
			if (e.message === 'invalid environment') {
				log.warn(`cannot delete environment for ${dropTableObj.schema}.${dropTableObj.table}, environment not found`);
			} else {
				throw e;
			}
		}

		try {
			let transactionPath = getTransactionAuditStorePath(dropTableObj.schema, dropTableObj.table);
			await environmentUtility.deleteEnvironment(transactionPath, dropTableObj.table, true);
		} catch (e) {
			if (e.message === 'invalid environment') {
				log.warn(`cannot delete environment for ${dropTableObj.schema}.${dropTableObj.table}, environment not found`);
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
 * @param dropTableObj
 * @returns {Promise<void>}
 */
async function deleteAttributesFromSystem(dropTableObj) {
	let searchObj = new SearchObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY,
		`${dropTableObj.schema}.${dropTableObj.table}`,
		undefined,
		[hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]
	);

	let searchResult = Array.from(await searchByValue(searchObj));

	let deleteIds = [];
	for (let x = 0; x < searchResult.length; x++) {
		let entry = searchResult[x];
		deleteIds.push(entry.id);
	}

	if (deleteIds.length === 0) {
		return;
	}

	let deleteTableObj = new DeleteObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
		deleteIds
	);

	await deleteRecords(deleteTableObj);
}

/**
 * Searches the system table for the table hash, then uses hash to delete table from system.
 * @param dropTableObj
 */
async function dropTableFromSystem(dropTableObj) {
	let searchObj = new SearchObject(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
		hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
		dropTableObj.table,
		undefined,
		[
			hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
			hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
			hdbTerms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
		]
	);
	let searchResult;
	let deleteTable;
	try {
		searchResult = Array.from(await searchByValue(searchObj));
	} catch (err) {
		throw err;
	}

	// Data found by the search function should match the dropTableObject
	for (let x = 0; x < searchResult.length; x++) {
		let item = searchResult[x];
		if (item.name === dropTableObj.table && item.schema === dropTableObj.schema) {
			deleteTable = item;
		}
	}

	if (!deleteTable) {
		throw new Error(`${dropTableObj.schema}.${dropTableObj.table} was not found`);
	}

	let deleteTableObj = new DeleteObject(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME, [
		deleteTable.id,
	]);
	try {
		await deleteRecords(deleteTableObj);
	} catch (err) {
		throw err;
	}
}
