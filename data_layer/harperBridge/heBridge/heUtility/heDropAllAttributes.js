'use strict';

const heDropAttribute = require('../heMethods/heDropAttribute');
const hdb_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');

module.exports = heDropAllAttributes;

function heDropAllAttributes(drop_obj) {
    let schema_table = global.hdb_schema[drop_obj.schema][drop_obj.table];
    if (hdb_utils.isEmpty(schema_table)) {
        throw new Error(`could not retrieve schema:${drop_obj.schema} and table ${drop_obj.table}`);
    }

    let current_attribute;
    let drop_attr_object = {
        operation: hdb_terms.OPERATIONS_ENUM.DROP_ATTRIBUTE,
        schema: drop_obj.schema,
        table: drop_obj.table,
        attribute: ''
    };

    try {
        for (let i = 0; i < schema_table.attributes.length; i++) {
            current_attribute = schema_table.attributes[i].attribute;
            drop_attr_object.attribute = current_attribute;
            heDropAttribute(drop_attr_object);
        }
    } catch(err) {
        log.error(`Error dropping attribute ${current_attribute}`);
        throw err;
    }
}