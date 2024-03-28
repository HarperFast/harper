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
const PARTIAL_DELETE_SUCCESS_MSG = 'Logs successfully deleted from transaction log.';
const ALL_DELETE_SUCCESS_MSG = 'All logs successfully deleted from transaction log.';

module.exports = {
	readTransactionLog,
	deleteTransactionLogsBefore,
};

/**
 * Queries a tables local Nats (clustering) stream (persistence layer), where all transactions against that table are stored.
 * @param {object} req - {schema, table, to, from, limit}
 * @returns {Promise<*[]>}
 */
async function* readTransactionLog(req) {
	const validation = readTransactionLogValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		throw handleHDBError(new Error(), CLUSTERING_DISABLED_MSG, HTTP_STATUS_CODES.NOT_FOUND, undefined, undefined, true);
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
	const transactions = await nats_utils.viewStreamIterator(stream_name, parseInt(req.from), req.limit);

	for await (const tx of transactions) {
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
			attributes: tx?.entry?.attributes,
		};

		if (tx?.entry?.operation === hdb_terms.OPERATIONS_ENUM.DELETE) formatted_tx.hash_values = tx?.entry?.hash_values;

		yield formatted_tx;
	}
}

/**
 * Deletes messages from a tables local Nats (clustering) stream (persistence layer),
 * where all transactions against that table are stored.
 * @param req - {schema, table, timestamp}
 * @returns {Promise<string>}
 */
async function deleteTransactionLogsBefore(req) {
	const validation = deleteTransactionLogsBeforeValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	if (!env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		throw handleHDBError(new Error(), CLUSTERING_DISABLED_MSG, HTTP_STATUS_CODES.NOT_FOUND, undefined, undefined, true);
	}

	const { schema, table, timestamp } = req;
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
	const { jsm } = await nats_utils.getNATSReferences();
	const stream_info = await nats_utils.getStreamInfo(stream_name);

	// Get first TS from first message in stream. If TS in req is less than/equal to
	// first stream message TS there are no messages to purge.
	const first_log_timestamp = new Date(stream_info.state.first_ts).getTime();
	if (timestamp <= first_log_timestamp) return `No transactions exist before: ${timestamp}`;

	let response = PARTIAL_DELETE_SUCCESS_MSG;
	let seq;
	const last_log_timestamp = new Date(stream_info.state.last_ts).getTime();
	// If req TS is greater than last message TS in stream we want to purge all messages
	// in the stream. To do this we get the last seq number.
	if (timestamp > last_log_timestamp) {
		// We plus one so that last_seq msg is included in the purge.
		seq = stream_info.state.last_seq + 1;
		response = ALL_DELETE_SUCCESS_MSG;
	} else {
		// If we get here the req TS falls somewhere in-between first and last stream message TS.
		// Using view stream filters get messages from a specific time onward with max message count of one.
		const transaction = await nats_utils.viewStream(stream_name, parseInt(timestamp), 1);
		seq = transaction[0].nats_sequence;
	}

	// Nats doesn't have the option to purge streams by timestamp only sequence.
	// This will purge all messages upto but not including seq.
	await nats_utils.purgeTableStream(schema, table, { seq });

	return response;
}
