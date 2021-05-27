'use strict';

const h_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const logger = require('../../../../utility/logging/harper_logger');
const fsCreateAttribute = require('../fsMethods/fsCreateAttribute');
const signalling = require('../../../../utility/signalling');
const { SchemaEventMsg } = require('../../../../server/ipc/utility/ipcUtils');

const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';

module.exports = checkForNewAttributes;

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist.
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 * @returns {Promise<void>}
 */
async function checkForNewAttributes(hdb_auth_header, table_schema, data_attributes){
    try {
        if (h_utils.isEmptyOrZeroLength(data_attributes)) {
            return data_attributes;
        }

        let raw_attributes = [];
        if (!h_utils.isEmptyOrZeroLength(table_schema.attributes)) {
            table_schema.attributes.forEach((attribute) => {
                raw_attributes.push(attribute.attribute);
            });
        }

        let new_attributes = data_attributes.filter(attribute => {
            return raw_attributes.indexOf(attribute) < 0;
        });

        if (new_attributes.length === 0) {
            return new_attributes;
        }

        await Promise.all(
            new_attributes.map(async attribute => {
                await createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
            })
        );

        return new_attributes;
    } catch(e){
        throw e;
    }
}

/**
 * check the existing schema and creates new attributes based on what the incoming records have
 * @param hdb_auth_header
 * @param schema
 * @param table
 * @param attribute
 */
async function createNewAttribute(hdb_auth_header,schema, table, attribute) {
    let attribute_object = {
        schema:schema,
        table:table,
        attribute:attribute
    };

    if(hdb_auth_header){
        attribute_object.hdb_auth_header = hdb_auth_header;
    }

    try {
        await createAttribute(attribute_object);
    } catch(e){
        //if the attribute already exists we do not want to stop the insert
        if(typeof e === 'object' && e.message !== undefined && e.message.includes(ATTRIBUTE_ALREADY_EXISTS)){
            logger.warn(e);
        } else {
            throw e;
        }
    }
}

async function createAttribute(create_attribute_object) {
    let attribute_structure;
    try {
        attribute_structure = await fsCreateAttribute(create_attribute_object);
        signalling.signalSchemaChange(new SchemaEventMsg(process.pid, hdb_terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, create_attribute_object.schema, create_attribute_object.table, create_attribute_object.attribute));

        return attribute_structure;
    } catch(err) {
        throw err;
    }
}
