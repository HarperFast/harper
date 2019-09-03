'use strict';

const terms = require('../../../../utility/hdbTerms');
const fsDeleteRecords = require('../fsMethods/fsDeleteRecords');



module.exports = deleteAttributeStructure;

async function deleteAttributeStructure(attribute_drop_obj) {
    //TODO: This is temporary. Once we have search by value bridge func built, we will use that.
    const util = require('util');
    const search_by_value = require('../../../search').searchByValue;
    let p_search_by_value = (util.promisify(search_by_value));

    let search_obj = {
        schema: terms.SYSTEM_SCHEMA_NAME,
        table: terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
        hash_attribute: terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY,
        get_attributes: [terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY, terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ATTRIBUTE_KEY]
    };

    if (attribute_drop_obj.table && attribute_drop_obj.schema) {
        search_obj.search_attribute = terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_TABLE_KEY;
        search_obj.search_value = `${attribute_drop_obj.schema}.${attribute_drop_obj.table}`;
    } else if (attribute_drop_obj.schema) {
        search_obj.search_attribute = terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY;
        search_obj.search_value = `${attribute_drop_obj.schema}`;
    } else {
        throw new Error('attribute drop requires table and or schema.');
    }

    try {
        let attributes = await p_search_by_value(search_obj);
        let attr = global.hdb_schema;

        if (attributes && attributes.length > 0) {
            let delete_table_obj = {
                table: terms.SYSTEM_TABLE_NAMES.ATTRIBUTE_TABLE_NAME,
                schema: terms.SYSTEM_SCHEMA_NAME,
                hash_values: []
            };

            for (let att in attributes) {
                if ((attribute_drop_obj.attribute && attribute_drop_obj.attribute === attributes[att].attribute)
                    || !attribute_drop_obj.attribute) {
                    delete_table_obj.hash_values.push(attributes[att].id);
                }
            }

            await fsDeleteRecords(delete_table_obj);

            return `successfully deleted ${delete_table_obj.hash_values.length} attributes`;
        }
    } catch(err) {
        throw err;
    }
}
