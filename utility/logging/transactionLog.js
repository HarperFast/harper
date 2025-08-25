'use strict';

const hdbTerms = require('../hdbTerms.ts');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const hdbUtils = require('../common_utils.js');
const envMgr = require('../environment/environmentManager.js');
const cryptoHash = require('../../security/cryptoHash.js');
const log = require('./harper_logger.js');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const {
	readTransactionLogValidator,
	deleteTransactionLogsBeforeValidator,
} = require('../../validation/transactionLogValidator.js');
const harperBridge = require('../../dataLayer/harperBridge/harperBridge.js');

const CLUSTERING_DISABLED_MSG = 'This operation relies on clustering and cannot run with it disable.';
const PARTIAL_DELETE_SUCCESS_MSG = 'Logs successfully deleted from transaction log.';
const ALL_DELETE_SUCCESS_MSG = 'All logs successfully deleted from transaction log.';

module.exports = {
	readTransactionLog,
	deleteTransactionLogsBefore,
};

async function readTransactionLog(req) {
	const validation = readTransactionLogValidator(req);
	if (validation) {
		throw handleHDBError(validation, validation.message, HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
	}

	req.database = req.database ?? req.schema ?? 'data';
	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(req.database, req.table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	if (!envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		log.info('Reading HarperDB logs used by Plexus');

		if (req.from || req.to) {
			req.search_type = 'timestamp';
			req.search_values = [req.from ?? 0];
			if (req.to) req.search_values[1] = req.to;
		}

		return harperBridge.readAuditLog(req);
	} else {
		return await readTransactionLogNats(req);
	}
}

/**
 * Queries a tables local Nats (clustering) stream (persistence layer), where all transactions against that table are stored.
 * @param {object} req - {schema, table, to, from, limit}
 * @returns {Promise<*[]>}
 */
async function* readTransactionLogNats(req) {
	const stream_name = cryptoHash.createNatsTableStreamName(req.database, req.table);
	// Using consumer and sub config we can filter a Nats stream with from date and max messages.
	const transactions = await natsUtils.viewStreamIterator(stream_name, parseInt(req.from), req.limit);

	for await (const tx of transactions) {
		// Nats uses nanosecond timestamps in their stream msgs but only accepts milliseconds when filtering streams.
		// To keep everything the same we convert timestamp to millisecond.
		const timestamp = Math.floor(tx?.nats_timestamp / 1000000);

		// If we have reached the 'to' timestamp exit loop.
		if (req.to && timestamp > req.to) break;

		const formattedTx = {
			operation: tx?.entry?.operation,
			user: tx?.entry?.__origin?.user,
			timestamp,
			records: tx?.entry?.records,
			attributes: tx?.entry?.attributes,
		};

		if (tx?.entry?.operation === hdbTerms.OPERATIONS_ENUM.DELETE) formattedTx.hash_values = tx?.entry?.hash_values;

		yield formattedTx;
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

	req.database = req.database ?? req.schema ?? 'data';
	if (!envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		log.info('Delete transaction logs called for Plexus');
		return harperBridge.deleteAuditLogsBefore(req);
	}

	const { database, table, timestamp } = req;
	const invalidSchemaTableMsg = hdbUtils.checkSchemaTableExist(database, table);
	if (invalidSchemaTableMsg) {
		throw handleHDBError(
			new Error(),
			invalidSchemaTableMsg,
			HTTP_STATUS_CODES.NOT_FOUND,
			undefined,
			undefined,
			true
		);
	}

	const stream_name = cryptoHash.createNatsTableStreamName(database, table);
	const { jsm } = await natsUtils.getNATSReferences();
	const streamInfo = await natsUtils.getStreamInfo(stream_name);

	// Get first TS from first message in stream. If TS in req is less than/equal to
	// first stream message TS there are no messages to purge.
	const firstLogTimestamp = new Date(streamInfo.state.first_ts).getTime();
	if (timestamp <= firstLogTimestamp) return `No transactions exist before: ${timestamp}`;

	let response = PARTIAL_DELETE_SUCCESS_MSG;
	let seq;
	const lastLogTimestamp = new Date(streamInfo.state.last_ts).getTime();
	// If req TS is greater than last message TS in stream we want to purge all messages
	// in the stream. To do this we get the last seq number.
	if (timestamp > lastLogTimestamp) {
		// We plus one so that lastSeq msg is included in the purge.
		seq = streamInfo.state.last_seq + 1;
		response = ALL_DELETE_SUCCESS_MSG;
	} else {
		// If we get here the req TS falls somewhere in-between first and last stream message TS.
		// Using view stream filters get messages from a specific time onward with max message count of one.
		const transaction = await natsUtils.viewStream(stream_name, parseInt(timestamp), 1);
		seq = transaction[0].nats_sequence;
	}

	// Nats doesn't have the option to purge streams by timestamp only sequence.
	// This will purge all messages upto but not including seq.
	await natsUtils.purgeTableStream(database, table, { seq });

	return response;
}
