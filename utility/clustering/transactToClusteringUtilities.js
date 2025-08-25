'use strict';

const commonUtils = require('../../utility/common_utils.js');
const env = require('../../utility/environment/environmentManager.js');
const hdbTerms = require('../hdbTerms.ts');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const harperLogger = require('../logging/harper_logger.js');
const ClusteringOriginObject = require('./ClusteringOriginObject.js');
const cryptoHash = require('../../security/cryptoHash.js');
env.initSync();

module.exports = {
	postOperationHandler,
	sendOperationTransaction,
};

/**
 * Publishes a transaction to local Nats stream which will enable the transaction to be propagated across the cluster.
 * @param requestBody
 * @param hashesToSend
 * @param origin
 * @param natsMsgHeader
 * @returns {Promise<void>}
 */
async function sendOperationTransaction(requestBody, hashesToSend, origin, natsMsgHeader) {
	if (requestBody.schema === hdbTerms.SYSTEM_SCHEMA_NAME) {
		return;
	}

	const transactionMsg = convertCRUDOperationToTransaction(requestBody, hashesToSend, origin);
	if (transactionMsg) {
		harperLogger.trace(
			`sendOperationTransaction publishing to schema ${requestBody.schema} following transaction:`,
			transactionMsg
		);
		await natsUtils.publishToStream(
			`${natsTerms.SUBJECT_PREFIXES.TXN}.${requestBody.schema}`,
			cryptoHash.createNatsTableStreamName(requestBody.schema, requestBody.table),
			natsMsgHeader,
			transactionMsg
		);
	}
}

/**
 * Converts a core CRUD operation to a cluster read message.
 * @param {{}}sourceJson - The source message body
 * @param {[string|number]} affectedHashes - Affected (successful) CRUD hashes
 * @param {ClusteringOriginObject} origin
 * @returns {*}
 */
function convertCRUDOperationToTransaction(sourceJson, affectedHashes, origin) {
	if (commonUtils.isEmptyOrZeroLength(affectedHashes)) {
		return null;
	}

	const transaction = {
		operation: sourceJson.operation,
		schema: sourceJson.schema,
		table: sourceJson.table,
		__origin: origin,
	};

	if (sourceJson.operation === hdbTerms.OPERATIONS_ENUM.DELETE) {
		transaction.hash_values = affectedHashes;
	} else {
		transaction.records = sourceJson.records;
	}

	return transaction;
}

/**
 * Manages how an operation is handled by clustering after the local node has processed it.
 * @param requestBody
 * @param result
 * @param natsMsgHeader
 * @returns {Promise<*>}
 */
async function postOperationHandler(requestBody, result, natsMsgHeader) {
	if (!env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		return;
	}

	harperLogger.trace(
		`postOperationHandler called for operation ${requestBody.operation} on schema.table: ${requestBody.schema}.${requestBody.table}`
	);
	const username = requestBody.hdb_user?.username;
	const thisNodeName = env.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);
	const origin = new ClusteringOriginObject(result.txn_time, username, thisNodeName);

	switch (requestBody.operation) {
		case hdbTerms.OPERATIONS_ENUM.INSERT:
			try {
				await sendOperationTransaction(requestBody, result.inserted_hashes, origin, natsMsgHeader);
			} catch (err) {
				harperLogger.error('There was an error calling clustering postOperationHandler for insert.');
				harperLogger.error(err);
			}
			break;
		case hdbTerms.OPERATIONS_ENUM.DELETE:
			try {
				await sendOperationTransaction(requestBody, result.deleted_hashes, origin, natsMsgHeader);
			} catch (err) {
				harperLogger.error('There was an error calling clustering postOperationHandler for delete.');
				harperLogger.error(err);
			}
			break;
		case hdbTerms.OPERATIONS_ENUM.UPDATE:
			try {
				await sendOperationTransaction(requestBody, result.update_hashes, origin, natsMsgHeader);
			} catch (err) {
				harperLogger.error('There was an error calling clustering postOperationHandler for update.');
				harperLogger.error(err);
			}
			break;
		case hdbTerms.OPERATIONS_ENUM.UPSERT:
			try {
				await sendOperationTransaction(requestBody, result.upserted_hashes, origin, natsMsgHeader);
			} catch (err) {
				harperLogger.error('There was an error calling clustering postOperationHandler for upsert.');
				harperLogger.error(err);
			}
			break;
		default:
			//do nothing
			break;
	}
	return result;
}
