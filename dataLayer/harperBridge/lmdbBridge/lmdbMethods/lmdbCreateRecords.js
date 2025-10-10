'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate.js');
// eslint-disable-next-line no-unused-vars
const InsertObject = require('../../../InsertObject.js');
const hdbTerms = require('../../../../utility/hdbTerms.ts');
const lmdbProcessRows = require('../lmdbUtility/lmdbProcessRows.js');
const lmdbInsertRecords = require('../../../../utility/lmdb/writeUtility.js').insertRecords;
const environmentUtility = require('../../../../utility/lmdb/environmentUtility.js');
const logger = require('../../../../utility/logging/harper_logger.js');

const lmdbCheckNewAttributes = require('../lmdbUtility/lmdbCheckForNewAttributes.js');
const { getSchemaPath } = require('../lmdbUtility/initializePaths.js');
const writeTransaction = require('../lmdbUtility/lmdbWriteTransaction.js');

module.exports = lmdbCreateRecords;

/**
 * Orchestrates the insertion of data into LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param {InsertObject} insertObj
 * @returns {Promise<{skipped_hashes: *, written_hashes: *, schema_table: *}>}
 */
async function lmdbCreateRecords(insertObj) {
	try {
		let { schemaTable, attributes } = insertUpdateValidate(insertObj);

		lmdbProcessRows(insertObj, attributes, schemaTable.hash_attribute);

		if (insertObj.schema !== hdbTerms.SYSTEM_SCHEMA_NAME) {
			if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
				attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
			}

			if (!attributes.includes(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
				attributes.push(hdbTerms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
			}
		}

		let new_attributes = await lmdbCheckNewAttributes(insertObj.hdb_auth_header, schemaTable, attributes);
		let envBasePath = getSchemaPath(insertObj.schema, insertObj.table);
		let environment = await environmentUtility.openEnvironment(envBasePath, insertObj.table);
		let lmdbResponse = await lmdbInsertRecords(
			environment,
			schemaTable.hash_attribute,
			attributes,
			insertObj.records,
			insertObj.__origin?.timestamp
		);

		try {
			await writeTransaction(insertObj, lmdbResponse);
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
