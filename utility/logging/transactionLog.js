'use strict';

const hdb_terms = require('../hdbTerms');
const nats_utils = require('../../server/nats/utility/natsUtils');
const hdb_utils = require('../common_utils');
const env_mgr = require('../environment/environmentManager');
const crypto_hash = require('../../security/cryptoHash');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
} = require('../../validation/transactionLogValidator');

const CLUSTERING_DISABLED_MSG = 'This operation relies on clustering and cannot run with it disable.';

module.exports = {
	readTransactionLog,
	deleteTransactionLogsBefore,
};

/**
 * Queries a tables local Nats (clustering) stream (persistence layer), where all transactions against that table are stored.
 * @param {object} req - {schema, table, to, from, limit}
 * @returns {Promise<*[]>}
 */
async function readTransactionLog(req) {
	const validation = readTransactionLogValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		throw handleHDBError(
			new Error(),
			CLUSTERING_DISABLED_MSG,
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	const { schema, table } = req;
	const invalid_schema_table_msg = hdb_utils.checkSchemaTableExist(schema, table);
	if (invalid_schema_table_msg) {
		throw handleHDBError(
			new Error(),
			invalid_schema_table_msg,
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
	// Using consumer and sub config we can filter a Nats stream with from date and max messages.
	const transactions = await nats_utils.viewStream(stream_name, parseInt(req.from), req.limit);

	// Build result from the array of messages in the Nats stream.
	let result = [];
	for (let i = 0, tx_length = transactions.length; i < tx_length; i++) {
		const tx = transactions[i];
		// Nats uses nanosecond timestamps in their stream msgs but only accepts milliseconds when filtering streams.
		// To keep everything the same we convert timestamp to millisecond.
		const timestamp = Math.floor(tx?.nats_timestamp / 1000000);

		// If we have reached the 'to' timestamp exit loop.
		if (req.to && timestamp > req.to) break;

		const formatted_tx = {
			operation: tx?.entry?.operation,
			user: tx?.entry?.__origin?.user,
			timestamp,
			records: tx?.entry?.records,
		};

		if (tx?.entry?.operation === hdb_terms.OPERATIONS_ENUM.DELETE) formatted_tx.hash_values = tx?.entry?.hash_values;

		result.push(formatted_tx);
	}

	return result;
}

// TODO: Built in Jira CORE-1613
async function deleteTransactionLogsBefore(req) {}
