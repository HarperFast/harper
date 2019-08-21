'use strict';

const log = require('../../../../utility/logging/harper_logger');
const schema_validator = require('../../../../validation/schema_validator');
const hdb_utils = require('../../../../utility/common_utils');
const hdb_core_global_schema = require('../../../../utility/globalSchema');
const insert_validator = require('../../../../validation/insertValidator');
const uuidV4 = require('uuid/v4');
const util = require('util');

const p_global_schema = util.promisify(hdb_core_global_schema.getTableSchema);

// TODO: this is temporary, it will be updated when search by value is added to the bridge.
const hdb_core_search = require('../../../search');
let p_search_search_by_value = util.promisify(hdb_core_search.searchByValue);

module.exports = createAttribute;

async function createAttribute(create_attribute_object) {
    let validation_error = schema_validator.attribute_object(create_attribute_object);
    if (validation_error) {
        throw validation_error;
    }

    let search_object = {
        schema: 'system',
        table: 'hdb_attribute',
        hash_attribute: 'id',
        get_attributes: ['*'],
        search_attribute: 'attribute',
        search_value: create_attribute_object.attribute
    };

    try {
        let attributes = await p_search_search_by_value(search_object);

        if(attributes && attributes.length > 0) {
            for (let att in attributes) {
                if (attributes[att].schema === create_attribute_object.schema
                    && attributes[att].table === create_attribute_object.table) {
                    throw new Error(`attribute already exists with id ${JSON.stringify(attributes[att])}`);
                }
            }
        }

        let record = {
            schema: create_attribute_object.schema,
            table: create_attribute_object.table,
            attribute: create_attribute_object.attribute,
            id: uuidV4(),
            schema_table: create_attribute_object.schema + '.' + create_attribute_object.table
        };

        if(create_attribute_object.id){
            record.id = create_attribute_object.id;
        }

        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_attribute',
            hash_attribute: 'id',
            records: [record]
        };

        log.info('insert object: ' + JSON.stringify(insert_object));
        let insert_response = await insertData(insert_object);
        log.info('attribute: ' + record.attribute);
        log.info(insert_response);

        return insert_response;
    } catch(err) {
        throw err;
    }
}

async function insertData(insert_object){
    try {
        let {schema_table, attributes} = await validation(insert_object);
        //let hdb_bridge_result = await harperBridge.createRecords(insert_object, attributes, schema_table);
        convertOperationToTransaction(insert_object, hdb_bridge_result.written_hashes, schema_table.hash_attribute);

        return returnObject(INSERT_ACTION, hdb_bridge_result.written_hashes, insert_object, hdb_bridge_result.skipped_hashes);
    } catch(e){
        throw (e);
    }
}

async function validation(write_object){
    // Need to validate these outside of the validator as the getTableSchema call will fail with
    // invalid values.

    if(hdb_utils.isEmpty(write_object)) {
        throw new Error('invalid update parameters defined.');
    }
    if(hdb_utils.isEmptyOrZeroLength(write_object.schema) ) {
        throw new Error('invalid schema specified.');
    }
    if(hdb_utils.isEmptyOrZeroLength(write_object.table) ) {
        throw new Error('invalid table specified.');
    }

    let schema_table = await p_global_schema(write_object.schema, write_object.table);

    //validate insert_object for required attributes
    let validator = insert_validator(write_object);
    if (validator) {
        throw validator;
    }

    if(!Array.isArray(write_object.records)) {
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
