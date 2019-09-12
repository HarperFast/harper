'use strict';

const fsCreateAttribute = require('../fsMethods/fsCreateAttribute');
const processData = require('../fsUtility/processData');
const processRows = require('../fsUtility/processRows');
const insertUpdateValidate = require('../../bridgeUtility/insertUpdateValidate');
const checkForNewAttributes = require('../../bridgeUtility/checkForNewAttr');
const log = require('../../../../utility/logging/harper_logger');
const hdb_utils = require('../../../../utility/common_utils');
const hdb_terms = require('../../../../utility/hdbTerms');
const signalling = require('../../../../utility/signalling');

const ATTRIBUTE_ALREADY_EXISTS = 'attribute already exists';

module.exports = createRecords;

/**
 * Calls all the functions specifically responsible for writing data to the file system
 * @param insert_obj
 * @returns {Promise<{skipped_hashes, written_hashes, schema_table}>}
 */
async function createRecords(insert_obj) {
    try {
        let {schema_table, attributes} = insertUpdateValidate(insert_obj);
        let data_wrapper = await processRows(insert_obj, attributes, schema_table);
        await checkAttributes(insert_obj.hdb_auth_header, schema_table, attributes);
        await processData(data_wrapper);

        let return_obj = {
            written_hashes: data_wrapper.written_hashes,
            skipped_hashes: data_wrapper.skipped_hashes,
            schema_table
        };

        return return_obj;
    } catch(err) {
        throw err;
    }
}

async function checkAttributes(hdb_auth_header, table_schema, data_attributes) {
    let new_attributes = checkForNewAttributes(table_schema, data_attributes);

    if (hdb_utils.isEmptyOrZeroLength(new_attributes)) {
        return;
    }

    try {
        await Promise.all(
            new_attributes.map(async attribute => {
                await createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
            })
        );
    } catch(err) {
        throw err;
    }
}

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
            log.warn(e);
        } else {
            throw e;
        }
    }
}

async function createAttribute(create_attribute_object) {
    let attribute_structure;
    try {
        if(global.clustering_on
            && !create_attribute_object.delegated && create_attribute_object.schema !== 'system') {

            attribute_structure = await fsCreateAttribute(create_attribute_object);
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
        attribute_structure = await fsCreateAttribute(create_attribute_object);
        let create_att_msg = hdb_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        create_att_msg.transaction = create_attribute_object;
        hdb_utils.sendTransactionToSocketCluster(hdb_terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, create_att_msg);
        signalling.signalSchemaChange({type: 'schema'});

        return attribute_structure;
    } catch(err) {
        throw err;
    }
}
