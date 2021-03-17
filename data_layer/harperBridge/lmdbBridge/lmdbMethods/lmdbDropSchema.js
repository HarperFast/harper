'use strict';

const fs = require('fs-extra');
const SearchObject = require('../../../SearchObject');
const SearchByHashObject = require('../../../SearchByHashObject');
const DeleteObject = require('../../../DeleteObject');
const drop_table = require('./lmdbDropTable');
const delete_records = require('./lmdbDeleteRecords');
const get_data_by_hash = require('./lmdbGetDataByHash');
const search_data_by_value = require('./lmdbSearchByValue');
const hdb_terms = require('../../../../utility/hdbTerms');
const path = require('path');
const {getBaseSchemaPath} = require('../lmdbUtility/initializePaths');
const { handleHDBError, hdb_errors } = require('../../../../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

module.exports = lmdbDropSchema;

/**
 * deletes all environment files under the schema folder, deletes all schema/table/attribute meta data from system
 * @param drop_schema_obj
 */
async function lmdbDropSchema(drop_schema_obj) {
    let delete_schema;

    try {
        delete_schema = await validateDropSchema(drop_schema_obj.schema);

        //We search in system > hdb_table for tables with the schema to ensure we are deleting all schema datastores
        const table_search_obj = new SearchObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY,
            delete_schema, undefined, [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]);

        let tables = await search_data_by_value(table_search_obj);

        for(let x = 0; x < tables.length; x++){
            const delete_table_obj = {
                schema: delete_schema,
                table: tables[x].name
            };
            try {
                await drop_table(delete_table_obj);
            } catch(e) {
                //this message would get thrown for an environment that doesn't exist
                if(e.message !== 'invalid environment') {
                    throw e;
                }
            }
        }

        //After all tables for schema are deleted, we can delete the schema
        const delete_schema_obj = new DeleteObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME, [delete_schema]);

        // Delete the schema from the system > hdb_schema datastore
        await delete_records(delete_schema_obj);

        let schema_path = path.join(getBaseSchemaPath(), delete_schema.toString());
        await fs.remove(schema_path);
    } catch(err) {
        throw err;
    }
}

async function validateDropSchema(drop_schema) {
    let search_obj = new SearchByHashObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.SCHEMA_TABLE_NAME, [drop_schema],
        [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY]);

    let search_result;
    let delete_schema;

    try {
        search_result = await get_data_by_hash(search_obj);
    } catch(err) {
        throw err;
    }

    // Data found by the search function should match the drop_schema
    for (let item in search_result) {
        if (search_result[item].name === drop_schema) {
            delete_schema = drop_schema;
        }
    }

    if (!delete_schema) {
        throw handleHDBError(new Error(), HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(drop_schema), HTTP_STATUS_CODES.NOT_FOUND);
    }

    return delete_schema;
}
