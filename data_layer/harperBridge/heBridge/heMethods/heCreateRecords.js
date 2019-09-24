'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const checkForNewAttributes = require('../../bridgeUtility/checkForNewAttr');
const heProcessRows = require('../heUtility/heProcessRows');
const heProcessInsertUpdateResponse = require('../heUtility/heProcessInsertUpdateResponse');
const heCreateAttribute = require('./heCreateAttribute');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../utility/hdbTerms');
const signalling = require('../../../../utility/signalling');
const heliumUtils = require('../../../../utility/helium/heliumUtils');

let hdb_helium;
try {
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    throw err;
}

const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';

module.exports = heCreateRecords;

/**
 * Orchestrates the insertion of data into Helium and the creation of new attributes/datastores
 * if they do not already exist.
 * @param insert_obj
 * @returns {Promise<{skipped_hashes: *, written_hashes: *, schema_table: *}>}
 */
function heCreateRecords(insert_obj) {
    try {
        let { schema_table, attributes } = insertUpdateValidate(insert_obj);
        let { datastores, processed_rows } = heProcessRows(insert_obj, attributes, schema_table);

        if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME)) {
            attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.CREATED_TIME);
        }

        if (!attributes.includes(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME)) {
            attributes.push(hdb_terms.HELIUM_TIME_STAMP_ENUM.UPDATED_TIME);
        }

        checkAttributes(insert_obj.hdb_auth_header, schema_table, attributes);
        let he_response = hdb_helium.insertRows(datastores, processed_rows);
        let { written_hashes, skipped_hashes } = heProcessInsertUpdateResponse(he_response);

        return {
            written_hashes,
            skipped_hashes,
            schema_table
        };
    } catch(err) {
        throw err;
    }
}

/**
 * Uses a utility function to check if there are any new attributes that dont exist. Utility function
 * references the global schema.
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 */
function checkAttributes(hdb_auth_header, table_schema, data_attributes) {
    let new_attributes = checkForNewAttributes(table_schema, data_attributes);
    if (hdb_utils.isEmptyOrZeroLength(new_attributes)) {
        return;
    }

    new_attributes.map(attribute => {
        createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
    });
}

/**
 * Starts the process of creating a new attribute and calls 'createAttribute' for each one
 * @param hdb_auth_header
 * @param schema
 * @param table
 * @param attribute
 */
function createNewAttribute(hdb_auth_header,schema, table, attribute) {
    let attribute_object = {
        schema,
        table,
        attribute
    };

    if(hdb_auth_header){
        attribute_object.hdb_auth_header = hdb_auth_header;
    }

    try {
        createAttribute(attribute_object);
    } catch(e){
        //if the attribute already exists we do not want to stop the insert
        if(e.message.includes(ATTRIBUTE_ALREADY_EXISTS)){
            log.warn(e);
        } else {
            throw e;
        }
    }
}

/**
 * Handles the actual creation of the attribute/datastore by calling heMethod 'heCreateAttribute'
 * Update cluster accordingly.
 * @param create_attribute_object
 * @returns {*}
 */
function createAttribute(create_attribute_object) {
    let attribute_structure;
    try {
        if(global.clustering_on
            && !create_attribute_object.delegated && create_attribute_object.schema !== 'system') {

            attribute_structure = heCreateAttribute(create_attribute_object);
            create_attribute_object.delegated = true;
            create_attribute_object.operation = 'create_attribute';
            create_attribute_object.id = attribute_structure.id;

            let payload = {
                "type": "clustering_payload",
                "pid": process.pid,
                "clustering_type": "broadcast",
                "id": attribute_structure.id,
                "body": create_attribute_object
            };

            hdb_utils.callProcessSend(payload);
            signalling.signalSchemaChange({type: 'schema'});

            return attribute_structure;
        }
        attribute_structure = heCreateAttribute(create_attribute_object);
        let create_att_msg = hdb_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        create_att_msg.transaction = create_attribute_object;
        hdb_utils.sendTransactionToSocketCluster(hdb_terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, create_att_msg);
        signalling.signalSchemaChange({type: 'schema'});

        return attribute_structure;
    } catch(err) {
        throw err;
    }
}
