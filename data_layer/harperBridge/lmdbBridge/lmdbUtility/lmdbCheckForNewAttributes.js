'use strict';

const h_utils = require('../../../../utility/common_utils');
const logger = require('../../../../utility/logging/harper_logger');
const lmdbCreateAttribute = require('../lmdbMethods/lmdbCreateAttribute');
const LMDBCreateAttributeObject = require('./LMDBCreateAttributeObject');
const signalling = require('../../../../utility/signalling');

const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';

module.exports = lmdbCheckForNewAttributes;

/**
 * Uses a utility function to check if there are any new attributes that dont exist. Utility function
 * references the global schema.
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 */
async function lmdbCheckForNewAttributes(hdb_auth_header, table_schema, data_attributes) {
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
    let attribute_object = new LMDBCreateAttributeObject(schema, table, attribute);

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

/**
 *
 * @param {LMDBCreateAttributeObject} create_attribute_object
 * @returns {Promise<*>}
 */
async function createAttribute(create_attribute_object) {
    let attribute_structure;
    try {
        attribute_structure = await lmdbCreateAttribute(create_attribute_object);
        signalling.signalSchemaChange({type: 'schema'});

        return attribute_structure;
    } catch(err) {
        throw err;
    }
}