'use strict';

const hdb_utils = require('../../../../utility/common_utils');
const insert_validator = require('../../../../validation/insertValidator');
const util = require('util');

module.exports = insertUpdateValidate;

const global_schema = require('../../../../utility/globalSchema');
const p_global_schema = util.promisify(global_schema.getTableSchema);

/**
 * Takes an insert/update object and validates attributes, also looks for dups and get a list of all attributes from the record set
 * @param {Object} write_object
 * @returns {Promise<{table_schema, hashes: any[], attributes: string[]}>}
 */
async function insertUpdateValidate(write_object){
    // Need to validate these outside of the validator as the getTableSchema call will fail with
    // invalid values.

    if (hdb_utils.isEmpty(write_object)) {
        throw new Error('invalid update parameters defined.');
    }
    if (hdb_utils.isEmptyOrZeroLength(write_object.schema)) {
        throw new Error('invalid schema specified.');
    }
    if (hdb_utils.isEmptyOrZeroLength(write_object.table)) {
        throw new Error('invalid table specified.');
    }

    let schema_table;
    try {
        schema_table = await p_global_schema(write_object.schema, write_object.table);
    } catch(err) {
        throw new Error(err);
    }

    //validate insert_object for required attributes
    let validator = insert_validator(write_object);
    if (validator) {
        throw validator;
    }

    if (!Array.isArray(write_object.records)) {
        throw new Error('records must be an array');
    }

    let hash_attribute = schema_table.hash_attribute;
    let dups = new Set();
    let attributes = {};

    let is_update = false;
    if (write_object.operation === 'update') {
        is_update = true;
    }

    write_object.records.forEach((record)=>{

        if (is_update && hdb_utils.isEmptyOrZeroLength(record[hash_attribute])) {
            throw new Error('a valid hash attribute must be provided with update record');
        }

        if (!hdb_utils.isEmpty(record[hash_attribute]) && record[hash_attribute] !== '' && dups.has(hdb_utils.autoCast(record[hash_attribute]))){
            record.skip = true;
        }

        dups.add(hdb_utils.autoCast(record[hash_attribute]));

        for (let attr in record) {
            attributes[attr] = 1;
        }
    });

    //in case the hash_attribute was not on the object(s) for inserts where they want to auto-key we manually add the hash_attribute to attributes
    attributes[hash_attribute] = 1;

    return {
        schema_table: schema_table,
        hashes: Array.from(dups),
        attributes: Object.keys(attributes)
    };
}
