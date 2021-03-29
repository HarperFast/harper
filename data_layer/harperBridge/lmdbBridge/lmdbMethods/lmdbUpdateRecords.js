'use strict';

const insert_update_validate = require('../../bridgeUtility/insertUpdateValidate');
const lmdb_process_rows = require('../lmdbUtility/lmdbProcessRows');
const lmdb_check_new_attributes = require('../lmdbUtility/lmdbCheckForNewAttributes');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_update_records = require('../../../../utility/lmdb/writeUtility').updateRecords;
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const {getBaseSchemaPath} = require('../lmdbUtility/initializePaths');
const write_transaction = require('../lmdbUtility/lmdbWriteTransaction');
const logger = require('../../../../utility/logging/harper_logger');

module.exports = lmdbUpdateRecords;

/**
 * Orchestrates the update of data in LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param update_obj
 * @returns {{skipped_hashes: *, written_hashes: *, schema_table: *}}
 */
async function lmdbUpdateRecords(update_obj) {
    try {
        let { schema_table, attributes } = insert_update_validate(update_obj);

        lmdb_process_rows(update_obj, attributes, schema_table.hash_attribute);

        if (update_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
            if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
                attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
            }

            if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
                attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
            }
        }

        let new_attributes = await lmdb_check_new_attributes(update_obj.hdb_auth_header, schema_table, attributes);
        let env_base_path = path.join(getBaseSchemaPath(), update_obj.schema.toString());
        let environment = await environment_utility.openEnvironment(env_base_path, update_obj.table);
        let lmdb_response = await lmdb_update_records(environment, schema_table.hash_attribute, attributes, update_obj.records);

        try {
            await write_transaction(update_obj, lmdb_response);
        }catch(e){
            logger.error(`unable to write transaction due to ${e.message}`);
        }

        return {
            written_hashes: lmdb_response.written_hashes,
            skipped_hashes: lmdb_response.skipped_hashes,
            schema_table,
            new_attributes,
            txn_time: lmdb_response.txn_time
        };
    } catch(err) {
        throw err;
    }
}