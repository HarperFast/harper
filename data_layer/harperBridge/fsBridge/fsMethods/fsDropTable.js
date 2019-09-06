'use strict';

const fsDeleteRecords = require('./fsDeleteRecords');
const moveFolderToTrash = require('../fsUtility/moveFolderToTrash');
const deleteAttrStructure = require('../fsUtility/deleteAttrStructure');
const fsSearchByValue = require('./fsSearchByValue');
const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');

const DATE_SUBSTR_LENGTH = 19;
let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);
const TRASH_BASE_PATH = `${env.getHdbBasePath()}/${terms.HDB_TRASH_DIR}/`;

module.exports = dropTable;

async function dropTable(drop_table_obj) {
    let search_obj = {
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        hash_attribute: terms.SYSTEM_TABLE_HASH,
        search_attribute: terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
        search_value: drop_table_obj.table,
        get_attributes: ['name', 'schema', 'id']
    };

    try {
        let search_result = await fsSearchByValue(search_obj);
        let delete_table_obj = buildDropTableObject(drop_table_obj, search_result);
        await fsDeleteRecords(delete_table_obj);
        await moveTableToTrash(drop_table_obj);
        await deleteAttrStructure(drop_table_obj);

        return `successfully deleted table ${drop_table_obj.schema}.${drop_table_obj.table}`;
    } catch(err) {
        log.error(err);
        throw err;
    }
}

/**
 * Builds a descriptor object that describes the table targeted for the trash.
 * @param drop_table_object - Top level descriptor of the table being moved.
 * @param data - The data found by the search function.
 * @returns {Promise<{schema: string, hash_attribute: string, hash_values: *[], table: string}>}
 */
function buildDropTableObject(drop_table_object, data) {
    let delete_table;

    // Data found by the search function should match the drop_table_object
    for (let item in data) {
        if (data[item].name === drop_table_object.table && data[item].schema === drop_table_object.schema) {
            delete_table = data[item];
        }
    }

    if (!delete_table) {
        throw new Error(`${drop_table_object.schema}.${drop_table_object.table} was not found`);
    }

    let delete_table_object = {
        table: terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
        schema: terms.SYSTEM_SCHEMA_NAME,
        hash_attribute: terms.SYSTEM_TABLE_HASH,
        hash_values: [delete_table.id]
    };

    return delete_table_object;
}

/**
 * Performs the move of the target table to the trash directory.
 * @param drop_table_object - Descriptor of the table being moved to trash.
 * @returns {Promise<void>}
 */
async function moveTableToTrash(drop_table_object) {
    let root_path = env.get(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY);
    let origin_path = `${root_path}/${terms.HDB_SCHEMA_DIR}/${drop_table_object.schema}/${drop_table_object.table}`;
    let destination_name = `${drop_table_object.schema}-${drop_table_object.table}-${current_date}`;
    let trash_path = `${TRASH_BASE_PATH}${destination_name}`;

    try {
        await moveFolderToTrash(origin_path, trash_path);
    } catch(err) {
        throw err;
    }
}
