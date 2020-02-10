'use strict';

const SearchObject = require('../../../../data_layer/SearchObject');
const hdb_terms = require('../../../../utility/hdbTerms');
const common_utils = require('../../../../utility/common_utils');
const search_by_value = require('./lmdbSearchByValue');

module.exports = lmdbDropAttribute;

/**
 * First deletes the attribute/dbi from lmdb then removes its record from system table
 * @param drop_attribute_obj
 * @returns {undefined}
 */
function lmdbDropAttribute(drop_attribute_obj) {
    //remove meta data
    //drop dbi
    //iterate rows and remove attribute data


}

/**
 * Searches the system attributes table for attribute record then sends record to delete to be removed from system table.
 * @param drop_attribute_obj
 * @returns {undefined}
 */
function dropAttributeFromSystem(drop_attribute_obj) {
    let search_obj = new SearchObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY,
        `${drop_attribute_obj.schema}.${drop_attribute_obj.table}`, undefined,
        [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY]);
    let search_obj = {
        schema: hdb_terms.SYSTEM_SCHEMA_NAME,
        table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
        search_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY,
        search_value: `${drop_attribute_obj.schema}.${drop_attribute_obj.table}`,
        get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY]
    };

    try {
        let table_attributes = heSearchByValue(search_obj);
        let attribute = table_attributes.filter(attr => attr[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY] === drop_attribute_obj.attribute);
        if (common_utils.isEmptyOrZeroLength(attribute)) {
            throw new Error(`Attribute ${drop_attribute_obj.attribute} was not found.`);
        }

        let id = attribute.map(attr => attr[hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]);

        let delete_table_obj = {
            table: hdb_terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
            schema: hdb_terms.SYSTEM_SCHEMA_NAME,
            hash_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
            hash_values: id
        };

        return heDeleteRecords(delete_table_obj);
    } catch(err) {
        throw err;
    }
}