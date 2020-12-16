'use strict';

const common_utils = require(`../utility/common_utils`);
const env = require(`../utility/environment/environmentManager`);
const terms = require('../utility/hdbTerms');
const harper_logger = require('../utility/logging/harper_logger');
const ClusteringOriginObject = require("./ClusteringOriginObject");
if(!env.isInitialized()){
    env.initSync();
}

module.exports = {
    concatSourceMessageHeader,
    sendAttributeTransaction,
    sendSchemaTransaction,
    postOperationHandler
};

/**
 * Propagates attribute metadata across the entire cluster.
 * @param result
 * @param request_body
 * @param transaction_msg
 * @param original_req
 */
function sendAttributeTransaction(result, request_body, transaction_msg, original_req) {
    if (global.hdb_socket_client === undefined){
        return;
    }

    if (!common_utils.isEmptyOrZeroLength(result.new_attributes) && request_body.schema !== terms.SYSTEM_SCHEMA_NAME) {
        result.new_attributes.forEach((attribute) => {
            transaction_msg.transaction = {
                operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
                schema: request_body.schema,
                table: request_body.table,
                attribute: attribute
            };

            sendSchemaTransaction(transaction_msg, terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, request_body, original_req);
        });
    }
}

function sendSchemaTransaction(transaction_msg, operation, request_body, orig_req) {
    if(orig_req) {
        concatSourceMessageHeader(transaction_msg, orig_req);
    }
    common_utils.sendTransactionToSocketCluster(operation, transaction_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
}

/**
 * Add any relevant data from an original request into a newly created outbound message.
 * @param outbound_message - The message about to be sent
 * @param orig_req - An inbound request which may contain relevant data the outbound message needs to contain (such as originator).
 */
function concatSourceMessageHeader(outbound_message, orig_req) {
    if(!outbound_message) {
        harper_logger.error('Invalid message passed to concatSourceMessageHeader');
        return;
    }
    if(!orig_req) {
        harper_logger.error('no orig request data passed to concatSourceMessageHeader');
        return;
    }
    // TODO: Do we need to include anything else in the hdb_header?
    if(orig_req.__originator) {
        if(!outbound_message.__originator) {
            outbound_message.__originator = {};
        }
        outbound_message.__originator = orig_req.__originator;
    }
}

function postOperationHandler(request_body, result, orig_req) {
    let transaction_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
    transaction_msg.__transacted = true;

    switch(request_body.operation) {
        case terms.OPERATIONS_ENUM.INSERT:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.inserted_hashes, orig_req, result.txn_time);
                sendAttributeTransaction(result, request_body, transaction_msg, orig_req);
            } catch(err) {
                harper_logger.error('There was an error calling insert followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.DELETE:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.deleted_hashes, orig_req, result.txn_time);
            } catch(err) {
                harper_logger.error('There was an error calling delete followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.UPDATE:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.update_hashes, orig_req, result.txn_time);
                sendAttributeTransaction(result, request_body, transaction_msg, orig_req);
            } catch(err) {
                harper_logger.error('There was an error calling update followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.UPSERT:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.upserted_hashes, orig_req, result.txn_time);
                sendAttributeTransaction(result, request_body, transaction_msg, orig_req);
            } catch(err) {
                harper_logger.error('There was an error calling upsert followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
            try {

                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CREATE_SCHEMA,
                    schema: request_body.schema,
                };
                sendSchemaTransaction(transaction_msg, terms.INTERNAL_SC_CHANNELS.CREATE_SCHEMA, request_body, orig_req);
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        case terms.OPERATIONS_ENUM.CREATE_TABLE:
            try {
                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CREATE_TABLE,
                    schema: request_body.schema,
                    table: request_body.table,
                    hash_attribute: request_body.hash_attribute
                };
                sendSchemaTransaction(transaction_msg, terms.INTERNAL_SC_CHANNELS.CREATE_TABLE, request_body, orig_req);
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
            try {
                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
                    schema: request_body.schema,
                    table: request_body.table,
                    attribute: request_body.attribute
                };
                if(orig_req) {
                    concatSourceMessageHeader(transaction_msg, orig_req);
                }
                common_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, transaction_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        case terms.OPERATIONS_ENUM.CSV_DATA_LOAD:
            try {
                //TODO this seems wrong, need to investigate: https://harperdb.atlassian.net/browse/CORE-1097
                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CSV_DATA_LOAD,
                    schema: request_body.schema,
                    table: request_body.table,
                    attribute: request_body.attribute
                };
                sendSchemaTransaction(transaction_msg, terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, request_body, orig_req);
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        default:
            //do nothing
            break;
    }
    return result;
}

function sendOperationTransaction(transaction_msg, request_body, hashes_to_send, orig_req, txn_timestamp) {
    if(request_body.schema === terms.SYSTEM_SCHEMA_NAME) {
        return;
    }

    if (global.hdb_socket_client === undefined){
        return;
    }

    transaction_msg = convertCRUDOperationToTransaction(request_body, hashes_to_send, txn_timestamp);
    if(transaction_msg) {
        if(orig_req) {
            concatSourceMessageHeader(transaction_msg, orig_req);
        }
        common_utils.sendTransactionToSocketCluster(`${request_body.schema}:${request_body.table}`, transaction_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
    }
}

/**
 * Converts a core CRUD operation to a cluster read message.
 * @param {{}}source_json - The source message body
 * @param {[string|number]} affected_hashes - Affected (successful) CRUD hashes
 * @param {number} txn_timestamp - timestamp the transaction committed
 * @returns {*}
 */
function convertCRUDOperationToTransaction(source_json, affected_hashes, txn_timestamp) {
    if (global.hdb_socket_client === undefined || common_utils.isEmptyOrZeroLength(affected_hashes)) {
        return null;
    }

    let username = undefined;
    if(source_json.hdb_user && source_json.hdb_user.username){
        username = source_json.hdb_user.username;
    }

    let transaction = {
        operation: source_json.operation,
        schema: source_json.schema,
        table: source_json.table,
        __origin: new ClusteringOriginObject(txn_timestamp, username, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY))
    };

    if(source_json.operation === terms.OPERATIONS_ENUM.DELETE) {
        transaction.hash_values = affected_hashes;
    } else{
        transaction.records = source_json.records;
    }

    let transaction_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
    transaction_msg.transaction = transaction;
    return transaction_msg;
}
