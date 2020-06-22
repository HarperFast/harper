'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
// eslint-disable-next-line no-unused-vars
const InsertObject = require('../../../InsertObject');
const hdb_terms = require('../../../../utility/hdbTerms');
const lmdbProcessRows = require('../lmdbUtility/lmdbProcessRows');
const lmdb_insert_records = require('../../../../utility/lmdb/writeUtility').insertRecords;
const environment_utility = require('../../../../utility/lmdb/environmentUtility');
const path = require('path');
const LMDBTransactionObject = require('../lmdbUtility/LMDBTransactionObject');

const lmdb_check_new_attributes = require('../lmdbUtility/lmdbCheckForNewAttributes');
const {getBaseSchemaPath, getTransactionStorePath} = require('../lmdbUtility/initializePaths');

module.exports = lmdbCreateRecords;

/**
 * Orchestrates the insertion of data into Helium and the creation of new attributes/dbis
 * if they do not already exist.
 * @param {InsertObject} insert_obj
 * @returns {Promise<{skipped_hashes: *, written_hashes: *, schema_table: *}>}
 */
async function lmdbCreateRecords(insert_obj) {
    try {
        let { schema_table, attributes } = insertUpdateValidate(insert_obj);

        lmdbProcessRows(insert_obj, attributes, schema_table.hash_attribute);

        if (insert_obj.schema !== hdb_terms.SYSTEM_SCHEMA_NAME) {
            if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME)) {
                attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.CREATED_TIME);
            }

            if (!attributes.includes(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME)) {
                attributes.push(hdb_terms.TIME_STAMP_NAMES_ENUM.UPDATED_TIME);
            }
        }

        let new_attributes = await lmdb_check_new_attributes(insert_obj.hdb_auth_header, schema_table, attributes);
        let env_base_path = path.join(getBaseSchemaPath(), insert_obj.schema.toString());
        let environment = await environment_utility.openEnvironment(env_base_path, insert_obj.table);
        let lmdb_response = lmdb_insert_records(environment, schema_table.hash_attribute, attributes, insert_obj.records);


        let txn_env_base_path = path.join(getTransactionStorePath(), insert_obj.schema.toString());
        let txn_environment = await environment_utility.openEnvironment(txn_env_base_path, insert_obj.table);
        let txn_object = new LMDBTransactionObject(insert_obj.operation, insert_obj.records, undefined, insert_obj.hdb_user.username, lmdb_response.txn_time);

        return {
            written_hashes: lmdb_response.written_hashes,
            skipped_hashes: lmdb_response.skipped_hashes,
            schema_table,
            new_attributes
        };
    } catch(err) {
        throw err;
    }
}