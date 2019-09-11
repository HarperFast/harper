'use strict';

const moveFolderToTrash = require('../fsUtility/moveFolderToTrash');
const getBasePath = require('../fsUtility/getBasePath');
const fsSearchByValue = require('./fsSearchByValue');
const fsDeleteRecords = require('./fsDeleteRecords');
const env = require('../../../../utility/environment/environmentManager');
const terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');

// This is used by moveFileToTrash to decide where to put the removed file(s) in the trash directory.
const ENTITY_TYPE_ENUM = {
    TABLE: 'table',
    SCHEMA: 'schema',
    ATTRIBUTE: 'attribute'
};

const DATE_SUBSTR_LENGTH = 19;
let current_date = new Date().toISOString().substr(0, DATE_SUBSTR_LENGTH);

module.exports = dropAttribute;

/**
 * Performs the move of the target attribute and it's __hdb_hash entry to the trash directory.
 * @param drop_attr_obj
 * @returns {Promise<string|boolean>}
 */
async function dropAttribute(drop_attr_obj) {
    // TODO: Need to do specific rollback actions if any of the actions below fails.  https://harperdb.atlassian.net/browse/HDB-312
    let origin_path = `${getBasePath()}/${drop_attr_obj.schema}/${drop_attr_obj.table}/${drop_attr_obj.attribute}`;
    let hash_path = `${getBasePath()}/${drop_attr_obj.schema}/${drop_attr_obj.table}/${terms.HASH_FOLDER_NAME}/${drop_attr_obj.attribute}`;
    let attribute_trash_path = `${env.get(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY)}/${terms.HDB_TRASH_DIR}/${ENTITY_TYPE_ENUM.ATTRIBUTE}/${drop_attr_obj.attribute}-${current_date}`;
    let attribute_hash_trash_path = `${attribute_trash_path}/${terms.HASH_FOLDER_NAME}/${drop_attr_obj.attribute}`;

    try {
        await moveFolderToTrash(origin_path, attribute_trash_path);
    } catch(err) {
        // Not good, rollback attribute folder
        if (err.code === 'ENOENT') {
            // If the attribute has been created but not had values inserted it will not exists in table, only in system schema.
            // For those cases we need to skip this delete.
            log.error(err);
        } else {
            log.error(`There was a problem moving the attribute at path ${origin_path} to the trash at path: ${attribute_trash_path}`);
            throw err;
        }
    }

    try {
        await moveFolderToTrash(hash_path, attribute_hash_trash_path);
    } catch(err) {
        // Not good, rollback attribute __hdb_hash folder and attribute folder
        if (err.code === 'ENOENT') {
            // If the attribute has been created but not had values inserted it will not exists in table, only in system schema.
            // For those cases we need to skip this delete.
            log.error(err);
        } else {
            log.error(`There was a problem moving the hash attribute at path ${origin_path} to the trash at path: ${attribute_trash_path}`);
            throw err;
        }
    }

    try {
        let drop_result = await dropAttributeFromSystem(drop_attr_obj);

        return drop_result;
    } catch(err) {
        // Not good, rollback attribute folder, __hdb_hash folder, and attribute removal from hdb_attribute if it happened.
        log.error(`There was a problem dropping attribute: ${drop_attr_obj.attribute} from hdb_attribute.`);
        throw err;
    }
}

/**
 * Remove an attribute from __hdb_attribute.
 * @param drop_attr_obj - the drop attribute json received in drop_attribute inbound message.
 * @returns {Promise<string>}
 */
async function dropAttributeFromSystem(drop_attr_obj) {
    let search_obj = {
        schema: 'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        search_attribute: 'attribute',
        search_value: drop_attr_obj.attribute,
        get_attributes: ['id']
    };

    try {
        let attributes = await fsSearchByValue(search_obj);
        if (!attributes || attributes.length < 1) {
            throw new Error(`Attribute ${drop_attr_obj.attribute} was not found.`);
        }

        let delete_table_obj = {
            table: "hdb_attribute",
            schema: "system",
            hash_attribute: "id",
            hash_values: [attributes[0].id]
        };

        let success_message = await fsDeleteRecords(delete_table_obj);

        return success_message;
    } catch(err) {
        throw err;
    }
}
