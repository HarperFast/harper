'use strict';

const fsDeleteRecords = require('./fsDeleteRecords');
const moveFolderToTrash = require('../fsUtility/moveFolderToTrash');
const deleteAttrStructure = require('../fsUtility/deleteAttrStructure');
const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const DATE_SUBSTR_LENGTH = 19;
let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
const TRASH_BASE_PATH = `${env.getHdbBasePath()}/${terms.HDB_TRASH_DIR}`;

module.exports = fsDropSchema;

async function fsDropSchema(drop_schema_obj) {
    let schema = drop_schema_obj.schema;
    let delete_schema_obj = {
        table: terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME,
        schema: terms.SYSTEM_SCHEMA_NAME,
        hash_values: [schema]
    };

    try {
        let tables = global.hdb_schema[schema];
        let table_ids = [];
        for (let table_name in tables) {
            table_ids.push({id: tables[table_name].id});
        }

        let delete_response = await fsDeleteRecords(delete_schema_obj);
        if(delete_response.deleted_hashes.length === 0){
            throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(drop_schema_obj.schema), HTTP_STATUS_CODES.NOT_FOUND);
        }
        await moveSchemaToTrash(drop_schema_obj, table_ids);
        await deleteAttrStructure(drop_schema_obj);
    } catch(err) {
        log.error(err);
        throw err;
    }
}

/**
 * Moves the schema and it's contained tables to the trash folder.  Note the trash folder is not
 * automatically emptied.
 *
 * @param drop_schema_obj - Object describing the table being dropped
 * @param tables - the tables contained by the schema that will also be deleted
 * @returns {Promise<void>}
 */
async function moveSchemaToTrash(drop_schema_obj, tables) {
    if (!tables) {
        throw new Error('tables parameter was null.');
    }

    let origin_path = `${env.getHdbBasePath()}/${terms.SCHEMA_DIR_NAME}/${drop_schema_obj.schema}`;
    let destination_name = `${drop_schema_obj.schema}-${current_date}`;
    let trash_path = `${TRASH_BASE_PATH}/${destination_name}`;

    try {
        await moveFolderToTrash(origin_path, trash_path);

        let delete_table_obj = {
            table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
            schema: terms.SYSTEM_SCHEMA_NAME,
            hash_values: []
        };

        if (tables && tables.length > 0) {
            for (let t in tables) {
                delete_table_obj.hash_values.push(tables[t].id);
            }
        }

        if( delete_table_obj.hash_values && delete_table_obj.hash_values.length > 0 ) {
            await fsDeleteRecords(delete_table_obj);
        }
    } catch(err) {
        throw err;
    }
}
