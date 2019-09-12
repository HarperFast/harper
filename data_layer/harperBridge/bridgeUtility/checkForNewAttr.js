'use strict';

const hdb_utils = require('../../../utility/common_utils');

module.exports = checkForNewAttributes;

/**
 * Compares the existing schema attributes to attributes from a record set and returns only the ones that exist.
 * @param hdb_auth_header
 * @param table_schema
 * @param data_attributes
 * @returns {Promise<void>}
 */
function checkForNewAttributes(table_schema, data_attributes){
    try {
        if (hdb_utils.isEmptyOrZeroLength(data_attributes)) {
            return;
        }

        let raw_attributes = [];
        if (!hdb_utils.isEmptyOrZeroLength(table_schema.attributes)) {
            table_schema.attributes.forEach((attribute) => {
                raw_attributes.push(attribute.attribute);
            });
        }

        let new_attributes = data_attributes.filter(attribute => {
            return raw_attributes.indexOf(attribute) < 0;
        });

        if (new_attributes.length === 0) {
            return;
        }

        return new_attributes;

        // await Promise.all(
        //     new_attributes.map(async attribute => {
        //         await createNewAttribute(hdb_auth_header, table_schema.schema, table_schema.name, attribute);
        //     })
        // );
    } catch(e){
        throw new Error(e);
    }
}
/*

/!**
 * check the existing schema and creates new attributes based on what the incoming records have
 * @param hdb_auth_header
 * @param schema
 * @param table
 * @param attribute
 *!/
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

            h_utils.callProcessSend(payload);
            signalling.signalSchemaChange({type: 'schema'});

            return attribute_structure;
        }
        attribute_structure = await fsCreateAttribute(create_attribute_object);
        let create_att_msg = h_utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
        create_att_msg.transaction = create_attribute_object;
        h_utils.sendTransactionToSocketCluster(hdb_terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, create_att_msg);
        signalling.signalSchemaChange({type: 'schema'});

        return attribute_structure;
    } catch(err) {
        throw err;
    }
}
*/
