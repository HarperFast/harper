'use strict';

const heGenerateDataStoreName = require('../heUtility/heGenerateDataStoreName');
const heDeleteRecords = require('./heDeleteRecords');
const heSearchByValue = require('./heSearchByValue');
const helium_utils = require('../../../../utility/helium/heliumUtils');
const hdb_terms = require('../../../../utility/hdbTerms');

let hdb_helium;
try {
    hdb_helium = helium_utils.initializeHelium();
} catch(err) {
    throw err;
}

module.exports = heDropAttribute;

/**
 * First deletes the attribute/datastore from helium then removes its record from system table
 * @param drop_attribute_obj
 * @returns {undefined}
 */
function heDropAttribute(drop_attribute_obj) {
    let datastore = [heGenerateDataStoreName(drop_attribute_obj.schema, drop_attribute_obj.table, drop_attribute_obj.attribute)];

    try {
        let he_response = hdb_helium.deleteDataStores(datastore);
        if (he_response[0][1] !== hdb_terms.HELIUM_RESPONSE_CODES.HE_ERR_OK) {
            throw new Error(he_response[0][1]);
        }

        return dropAttributeFromSystem(drop_attribute_obj);
    } catch(err) {
        throw err;
    }

}

/**
 * Searches the system attributes table for attribute record then sends record to delete to be removed from system table.
 * @param drop_attribute_obj
 * @returns {undefined}
 */
function dropAttributeFromSystem(drop_attribute_obj) {
    let search_obj = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
        hash_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
        search_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY,
        search_value: drop_attribute_obj.attribute,
        get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]
    };

    try {
        let attributes = heSearchByValue(search_obj);
        if (!attributes || attributes.length < 1) {
            throw new Error(`Attribute ${drop_attribute_obj.attribute} was not found.`);
        }

        let delete_table_obj = {
            table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            hash_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
            hash_values: [attributes[0].id]
        };

        return heDeleteRecords(delete_table_obj);
    } catch(err) {
        throw err;
    }
}