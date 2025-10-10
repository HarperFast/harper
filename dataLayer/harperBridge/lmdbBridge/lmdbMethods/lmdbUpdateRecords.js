'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate.js');
const lmdbProcessRows = require('../lmdbUtility/lmdbProcessRows.js');
const lmdbCheckNewAttributes = require('../lmdbUtility/lmdbCheckForNewAttributes.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const lmdb_update_records = require('../../../../utility/lmdb/writeUtility.js').updateRecords;
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const writeTransaction = require('../lmdbUtility/lmdbWriteTransaction.js');
const logger = require('../../../../utility/logging/harper_logger.js');

module.exports = lmdbUpdateRecords;

/**
 * Orchestrates the update of data in LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param updateObj
 * @returns {{skipped_hashes: *, written_hashes: *, schema_table: *}}
 */
async function lmdbUpdateRecords(updateObj) {
	try {
		let { schemaTable, attributes } = insertUpdateValidate(updateObj);

		lmdbProcessRows(updateObj, attributes, schemaTable.hash_attribute);

		if (updateObj.schema !== hdbTerms.SYSTEM_SCHEMA_NAME) {
			if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
				attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
			}

			if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
				attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
			}
		}

		let new_attributes = await lmdbCheckNewAttributes(updateObj.hdb_auth_header, schemaTable, attributes);
		let envBasePath = getSchemaPath(updateObj.schema, updateObj.table);
		let environment = await environmentUtility.openEnvironment(envBasePath, updateObj.table);
		let lmdbResponse = await lmdb_update_records(
			environment,
			schemaTable.hash_attribute,
			attributes,
			updateObj.records,
			updateObj.__origin?.timestamp
		);

		try {
			await writeTransaction(updateObj, lmdbResponse);
		} catch (e) {
			logger.error(`unable to write transaction due to ${e.message}`);
		}

		return {
			written_hashes: lmdbResponse.written_hashes,
			skipped_hashes: lmdbResponse.skipped_hashes,
			schemaTable,
			new_attributes,
			txn_time: lmdbResponse.txn_time,
		};
	} catch (err) {
		throw err;
	}
}
