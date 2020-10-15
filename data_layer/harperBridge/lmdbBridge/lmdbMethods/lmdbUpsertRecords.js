'use strict';

const UpsertObject = require('../../../data_objects/UpsertObject');
const insert_update_validate = require('../../bridgeUtility/insertUpdateValidate');
const lmdb_process_rows = require('../lmdbUtility/lmdbProcessRows');
const lmdb_check_new_attributes = require('../lmdbUtility/lmdbCheckForNewAttributes');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdb_upsert_records = require('../../../../utility/lmdb/writeUtility').upsertRecords;
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const {getBaseSchemaPath} = require('../lmdbUtility/initializePaths');
const { handleValidationError } = require('../../../../utility/errors/hdbError');

module.exports = lmdbUpsertRecords;

/**
 * Orchestrates the UPSERT of data in LMDB and the creation of new attributes/dbis
 * if they do not already exist.
 * @param {UpsertObject} update_obj
 * @returns {{ skipped_hashes: *, written_hashes: *, schema_table: *, new_attributes: *, txn_time: * }}
 */
async function lmdbUpsertRecords(upsert_obj) {
    let validation_result;
    try {
        validation_result = insert_update_validate(upsert_obj);
    } catch(err) {
        throw handleValidationError(err, err.message);
    }

    let { schema_table, attributes} = validation_result;

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
    let lmdb_response = lmdb_upsert_records(environment, schema_table.hash_attribute, attributes, upsert_obj.records);

    //TODO - will be wired in as part of CORE-1142
    //try {
    //     await write_transaction(upsert_obj, lmdb_response);
    // }catch(e){
    //     logger.error(`unable to write transaction due to ${e.message}`);
    // }

    return {
        written_hashes: lmdb_response.written_hashes,
        schema_table,
        new_attributes,
        txn_time: lmdb_response.txn_time
    };

}
