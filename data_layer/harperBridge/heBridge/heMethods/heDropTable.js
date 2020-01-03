'use strict';

const heDropAllAttributes = require('../heUtility/heDropAllAttributes');
const heSearchByValue = require('./heSearchByValue');
const heDeleteRecords = require('./heDeleteRecords');
const hdb_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');

module.exports = heDropTable;

/**
 * Calls heDropAttribute on each attribute in the table. This will delete the actual attribute/datastore
 * @param drop_table_obj
 */
function heDropTable(drop_table_obj) {
        try {
            heDropAllAttributes(drop_table_obj);
            dropTableFromSystem(drop_table_obj);
    } catch(err) {
        throw err;
    }
}

/**
 * Searches the system table for the table hash, then uses hash to delete table from system.
 * @param drop_table_obj
 */
function dropTableFromSystem(drop_table_obj) {
    let search_obj = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        search_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
        search_value: drop_table_obj.table,
        get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]
    };
    let search_result;
    let delete_table;

    try {
         search_result = heSearchByValue(search_obj);
    } catch(err) {
        throw err;
    }

    // Data found by the search function should match the drop_table_object
    for (let item in search_result) {
        if (search_result[item].name === drop_table_obj.table && search_result[item].schema === drop_table_obj.schema) {
            delete_table = search_result[item];
        }
    }

    if (!delete_table) {
        throw new Error(`${drop_table_obj.schema}.${drop_table_obj.table} was not found`);
    }

    let delete_table_obj = {
        table: hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        hash_attribute: hdb_terms.SYSTEM_TABLE_HASH_ATTRIBUTES.TABLE_TABLE_HASH_ATTRIBUTE,
        hash_values: [delete_table.id]
    };
    try {
        heDeleteRecords(delete_table_obj);
    } catch(err) {
        throw err;
    }
}