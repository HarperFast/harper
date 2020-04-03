'use strict';

const drop_attribute = require('../lmdbMethods/lmdbDropAttribute');
const DropAttributeObject = require('../../../../data_layer/DropAttributeObject');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const LMDB_ERROR = require('../../../../utility/commonErrors').LMDB_ERRORS_ENUM;

module.exports = lmdbDropAllAttributes;

/**
 * drops all attributes from a table
 * @param drop_obj
 */
async function lmdbDropAllAttributes(drop_obj) {
    if(hdb_utils.isEmpty(global.hdb_schema[drop_obj.schema]) || hdb_utils.isEmpty(global.hdb_schema[drop_obj.schema][drop_obj.table])){
        throw new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`);
    }

    let schema_table = global.hdb_schema[drop_obj.schema][drop_obj.table];

    let current_attribute;
    try {
        for (let i = 0; i < schema_table.attributes.length; i++) {
            current_attribute = schema_table.attributes[i].attribute;
            let drop_attr_object = new DropAttributeObject(drop_obj.schema, drop_obj.table, current_attribute);
            try {
                await drop_attribute(drop_attr_object, false);
            } catch(e){
                if(e.message !== LMDB_ERROR.DBI_DOES_NOT_EXIST){
                    log.error(`unable to drop attribute ${drop_obj.schema}.${drop_obj.table}.${current_attribute}:` + e);
                }
            }
        }
    } catch(err) {
        log.error(`Error dropping attribute ${current_attribute}`);
        throw err;
    }
}