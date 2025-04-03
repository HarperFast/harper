'use strict';

const common_utils = require('../../utility/common_utils');
const env = require('../../utility/environment/environmentManager');
const hdb_terms = require('../hdbTerms');
const nats_terms = require('../../server/nats/utility/natsTerms');
const nats_utils = require('../../server/nats/utility/natsUtils');
const harper_logger = require('../logging/harper_logger');
const ClusteringOriginObject = require('./ClusteringOriginObject');
const crypto_hash = require('../../security/cryptoHash');
env.initSync();

module.exports = {
	postOperationHandler,
	sendOperationTransaction,
};

/**
 * Publishes a transaction to local Nats stream which will enable the transaction to be propagated across the cluster.
 * @param request_body
 * @param hashes_to_send
 * @param origin
 * @param nats_msg_header
 * @returns {Promise<void>}
 */
async function sendOperationTransaction(request_body, hashes_to_send, origin, nats_msg_header) {
	if (request_body.schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
		return;
	}

	const transaction_msg = convertCRUDOperationToTransaction(request_body, hashes_to_send, origin);
	if (transaction_msg) {
		harper_logger.trace(
			`sendOperationTransaction publishing to schema ${request_body.schema} following transaction:`,
			transaction_msg
		);
		await nats_utils.publishToStream(
			`${nats_terms.SUBJECT_PREFIXES.TXN}.${request_body.schema}`,
			crypto_hash.createNatsTableStreamName(request_body.schema, request_body.table),
			nats_msg_header,
			transaction_msg
		);
	}
}

/**
 * Converts a core CRUD operation to a cluster read message.
 * @param {{}}source_json - The source message body
 * @param {[string|number]} affected_hashes - Affected (successful) CRUD hashes
 * @param {ClusteringOriginObject} origin
 * @returns {*}
 */
function convertCRUDOperationToTransaction(source_json, affected_hashes, origin) {
	if (common_utils.isEmptyOrZeroLength(affected_hashes)) {
		return null;
	}

	const transaction = {
		operation: source_json.operation,
		schema: source_json.schema,
		table: source_json.table,
		__origin: origin,
	};

	if (source_json.operation === hdb_terms.OPERATIONS_ENUM.DELETE) {
		transaction.hash_values = affected_hashes;
	} else {
		transaction.records = source_json.records;
	}

	return transaction;
}

/**
 * Manages how an operation is handled by clustering after the local node has processed it.
 * @param request_body
 * @param result
 * @param nats_msg_header
 * @returns {Promise<*>}
 */
async function postOperationHandler(request_body, result, nats_msg_header) {
	if (!env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		return;
	}

	harper_logger.trace(
		`postOperationHandler called for operation ${request_body.operation} on schema.table: ${request_body.schema}.${request_body.table}`
	);
	const username = request_body.hdb_user?.username;
	const this_node_name = env.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);
	const origin = new ClusteringOriginObject(result.txn_time, username, this_node_name);

	switch (request_body.operation) {
		case hdb_terms.OPERATIONS_ENUM.INSERT:
			try {
				await sendOperationTransaction(request_body, result.inserted_hashes, origin, nats_msg_header);
			} catch (err) {
				harper_logger.error('There was an error calling clustering postOperationHandler for insert.');
				harper_logger.error(err);
			}
			break;
		case hdb_terms.OPERATIONS_ENUM.DELETE:
			try {
				await sendOperationTransaction(request_body, result.deleted_hashes, origin, nats_msg_header);
			} catch (err) {
				harper_logger.error('There was an error calling clustering postOperationHandler for delete.');
				harper_logger.error(err);
			}
			break;
		case hdb_terms.OPERATIONS_ENUM.UPDATE:
			try {
				await sendOperationTransaction(request_body, result.update_hashes, origin, nats_msg_header);
			} catch (err) {
				harper_logger.error('There was an error calling clustering postOperationHandler for update.');
				harper_logger.error(err);
			}
			break;
		case hdb_terms.OPERATIONS_ENUM.UPSERT:
			try {
				await sendOperationTransaction(request_body, result.upserted_hashes, origin, nats_msg_header);
			} catch (err) {
				harper_logger.error('There was an error calling clustering postOperationHandler for upsert.');
				harper_logger.error(err);
			}
			break;
		default:
			//do nothing
			break;
	}
	return result;
}
