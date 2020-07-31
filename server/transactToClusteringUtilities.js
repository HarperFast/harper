'use strict';

const common_utils = require(`../utility/common_utils`);
const env = require(`../utility/environment/environmentManager`);
const terms = require('../utility/hdbTerms');
const harper_logger = require('../utility/logging/harper_logger');
if(!env.isInitialized()){
    env.initSync();
}

module.exports = {
    concatSourceMessageHeader,
    sendAttributeTransaction,
    sendSchemaTransaction
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