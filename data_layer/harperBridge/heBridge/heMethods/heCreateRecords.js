'use strict';

const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const checkForNewAttributes = require('../../bridgeUtility/checkForNewAttr');
const heProcessRows = require('../heUtility/heProcessRows');
const heCreateAttribute = require('./heCreateAttribute');
const hdb_utils = require('../../../../utility/common_utils');
const log = require('../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../utility/hdbTerms');
const signalling = require('../../../../utility/signalling');
const heliumUtils = require('../../../../utility/helium/heliumUtils');
let hdb_helium = heliumUtils.initializeHelium();

const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';

module.exports = createRecords;

/**
 * Orchestrates the insertion of data into Helium and the creation of new attributes/datastores
 * if they do not already exist.
 * @param insert_obj
 * @returns {Promise<{skipped_hashes: *, written_hashes: *, schema_table: *}>}
 */
async function createRecords(insert_obj) {
    let he_response;
    let datastores;
    let rows;

    try {
        let { schema_table, attributes } = insertUpdateValidate(insert_obj);
        let { datastores, rows } = heProcessRows(insert_obj, attributes, schema_table);
        checkAttributes(insert_obj.hdb_auth_header, schema_table, attributes);
    } catch(err) {
        throw err;
    }

    try {
        he_response = hdb_helium.insertRows(datastores, rows);
    } catch(err) {
        throw err;
    }

    let { written_hashes, skipped_hashes } = processHeliumResponse(he_response);

    let return_obj = {
        written_hashes,
        skipped_hashes,
        schema_table
    };

    return return_obj;
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
        schema:schema,
        table:table,
        attribute:attribute
    };

    if(hdb_auth_header){
        attribute_object.hdb_auth_header = hdb_auth_header;
    }

    try {
        createAttribute(attribute_object);
    } catch(e){
        //if the attribute already exists we do not want to stop the insert
        if(typeof e === 'object' && e.message !== undefined && e.message.includes(ATTRIBUTE_ALREADY_EXISTS)){
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

/**
 * Helium API returns a multi-dimensional array from the createRecords call. This function transforms that response
 * into two arrays, one with hashes of written records the other with hashes of skipped records due to them
 * already existing.
 * @param he_response
 * @returns {{skipped_hashes: *, written_hashes: *}}
 */
function processHeliumResponse(he_response) {
    let written_hashes = he_response[0];
    let skipped_hashes = [];
    for (let i = 0; i < he_response[1].length; i++) {
        skipped_hashes.push(he_response[1][i][0]);
    }

    return {
        written_hashes,
        skipped_hashes
    };
}
