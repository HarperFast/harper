'use strict';

// eslint-disable-next-line no-unused-vars
const UpsertObject = require('../../../data_objects/UpsertObject');
const insert_update_validate = require('../../bridgeUtility/insertUpdateValidate');
const lmdb_process_rows = require('../lmdbUtility/lmdbProcessRows');
const lmdb_check_new_attributes = require('../lmdbUtility/lmdbCheckForNewAttributes');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_upsert_records = require('../../../../utility/lmdb/writeUtility').upsertRecords;
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const { getBaseSchemaPath } = require('../lmdbUtility/initializePaths');
const write_transaction = require('../lmdbUtility/lmdbWriteTransaction');

const logger = require('../../../../utility/logging/harper_logger');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');

module.exports = lmdbUpsertRecords;

/**
 * Orchestrates the UPSERT of data in LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param {UpsertObject} upsert_obj
 * @returns {{ skipped_hashes: *, written_hashes: *, schema_table: *, new_attributes: *, txn_time: * }}
 */
async function lmdbUpsertRecords(upsert_obj) {
	let validation_result;
	try {
		validation_result = insert_update_validate(upsert_obj);
	} catch (err) {
		throw handleHDBError(err, err.message, hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	let { schema_table, attributes } = validation_result;

	lmdb_process_rows(upsert_obj, attributes, schema_table.hash_attribute);

	if (upsert_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
		if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
			attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
		}

		if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
			attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
		}
	}

	let new_attributes = await lmdb_check_new_attributes(upsert_obj.hdb_auth_header, schema_table, attributes);
	let env_base_path = path.join(getBaseSchemaPath(), upsert_obj.schema.toString());
	let environment = await environment_utility.openEnvironment(env_base_path, upsert_obj.table);
	let lmdb_response = await lmdb_upsert_records(
		environment,
		schema_table.hash_attribute,
		attributes,
		upsert_obj.records,
		upsert_obj[hdb_terms.CLUSTERING_FLAG] !== true
	);

	try {
		await write_transaction(upsert_obj, lmdb_response);
	} catch (e) {
		logger.error(`unable to write transaction due to ${e.message}`);
	}

	return {
		written_hashes: lmdb_response.written_hashes,
		schema_table,
		new_attributes,
		txn_time: lmdb_response.txn_time,
	};
}
