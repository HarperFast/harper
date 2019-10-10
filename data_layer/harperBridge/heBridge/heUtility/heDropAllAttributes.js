'use strict';

const heDropAttribute = require('../heMethods/heDropAttribute');
const hdb_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const log = require('../../../../utility/logging/harper_logger');

module.exports = heDropAllAttributes;

function heDropAllAttributes(drop_obj) {
    if(hdb_utils.isEmpty(global.hdb_schema[drop_obj.schema]) || hdb_utils.isEmpty(global.hdb_schema[drop_obj.schema][drop_obj.table])){
        throw new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`);
    }
    let schema_table = global.hdb_schema[drop_obj.schema][drop_obj.table];

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
            try {
                heDropAttribute(drop_attr_object);
            } catch(e){
                if(e.message !== 'HE_ERR_DATASTORE_NOT_FOUND'){
                    throw e;
                }
            }
        }
    } catch(err) {
        log.error(`Error dropping attribute ${current_attribute}`);
        throw err;
    }
}