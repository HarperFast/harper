'use strict';

const util = require('util');
const { toJsMsg } = require('nats');
const { decode } = require('msgpackr');
const { isMainThread, parentPort } = require('worker_threads');
const nats_utils = require('./utility/natsUtils');
const nats_terms = require('./utility/natsTerms');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const server_utilities = require('../serverHelpers/serverUtilities');
const operation_function_caller = require('../../utility/OperationFunctionCaller');
const transact_to_cluster_utilities = require('../../utility/clustering/transactToClusteringUtilities');
const env_mgr = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
require('../threads/manageThreads');
const { getDatabases } = require('../../resources/tableLoader');

const SUBSCRIPTION_OPTIONS = {
	durable: nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name,
	queue: nats_terms.WORK_QUEUE_CONSUMER_NAMES.deliver_group,
};

let nats_connection;
let server_name;
let js_manager;
let js_client;

module.exports = {
	initialize,
	workQueueListener,
};

/**
 * This module is designed to manage messages in the Nats/clustering work queue stream. It is run as a separate process
 * managed by processManagement. The work queue stream gets messages from other nodes. A message is a HDB transaction that was performed
 * on a remote node. This module repetitively sets up a Nats consumer on the work queue and grabs any new messages from it.
 * When it receives a new message it will decide what the HDB transaction is, and then run it locally.
 * https://docs.nats.io/nats-concepts/jetstream/streams
 * https://github.com/nats-io/nats.deno/blob/main/jetstream.md
 */

/**
 * initialized schema, itc handler, established nats connection & jetstream handlers
 * @returns {Promise<void>}
 */
async function initialize() {
	harper_logger.notify('Starting clustering ingest service.');

	const { connection, jsm, js } = await nats_utils.getNATSReferences();
	nats_connection = connection;
	server_name = connection.info.server_name;
	js_manager = jsm;
	js_client = js;
}
const MAX_CONCURRENCY = 100;
const outstanding_operations = new Array(MAX_CONCURRENCY);
let operation_index = 0;
/**
 * Uses an internal Nats consumer to subscribe to the  of messages from the work queue and process each one.
 * @returns {Promise<void>}
 */
async function workQueueListener() {
	const sub = nats_connection.subscribe(
		`${nats_terms.WORK_QUEUE_CONSUMER_NAMES.deliver_subject}.${nats_connection.info.server_name}`,
		SUBSCRIPTION_OPTIONS
	);

	for await (const message of sub) {
		// ring style queue for awaiting operations for concurrency. await the entry from 100 operations ago:
		await outstanding_operations[operation_index];
		outstanding_operations[operation_index] = messageProcessor(message).catch((error) => {
			harper_logger.error(error);
		});
		if (++operation_index >= MAX_CONCURRENCY) operation_index = 0;
	}
}

if (!isMainThread) {
	parentPort.on('message', async (message) => {
		const { type } = message;
		if (type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
			nats_utils.closeConnection();
		}
	});
}
/**
 * receives a message & processes it as an HDB operation
 * @param msg
 * @returns {Promise<{}>}
 */
async function messageProcessor(msg) {
	const js_msg = toJsMsg(msg);
	const entry = decode(js_msg.data);

	// If the msg origin header matches this node the msg can be ignored because it would have already been processed.
	const origin = js_msg.headers.get(nats_terms.MSG_HEADERS.ORIGIN);
	if (origin === env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME)) {
		js_msg.ack();
		return;
	}

	harper_logger.trace('processing message:', entry, 'with sequence:', js_msg.seq);
	harper_logger.trace(`messageProcessor nats msg id: ${js_msg.headers.get(nats_terms.MSG_HEADERS.NATS_MSG_ID)}`);
	try {
		let single_table_operation = entry.operation;
		if (single_table_operation) {
			// this is a legacy message that operates on a single table
			let { schema, table: table_name, records, timestamp } = entry;
			let Table = getDatabases()[schema][table_name];
			await Table.transact(
				async (txn_table) => {
					switch (single_table_operation) {
						case 'put':
						case 'upsert':
						case 'insert':
						case 'update':
							for (let record of records) {
								await txn_table.put(record, entry.origin);
							}
							break;
						case 'delete':
							for (let record of records) {
								await txn_table.delete(record, entry.origin);
							}
							break;
					}
				},
				{
					timestamp,
				}
			);
		} else {
			let { timestamp, writes } = entry;
			let first_dot_index = msg.subject.indexOf('.');
			let second_dot_index = msg.subject.indexOf('.', first_dot_index + 1);
			let schema = msg.subject.slice(first_dot_index + 1, second_dot_index);
			let first_table = writes[0].table;
			let database = getDatabases()[schema];
			if (!database) throw new Error(`The database ${schema} was not found.`);
			let Table = database[first_table];
			await Table.transact(
				async (txn_table) => {
					for (let write of writes) {
						let table = first_table === write.table ? txn_table : txn_table.useTable(write.table);
						switch (write.operation) {
							case 'put':
								await table.put(write.record);
								break;
							case 'delete':
								await table.delete(write.id);
								break;
						}
					}
				},
				{ timestamp }
			);
		}
	} catch (e) {
		harper_logger.error(e);
	}

	/*	const found_operation = server_utilities.getOperationFunction(entry);
	operation_function = found_operation.job_operation_function
		? found_operation.job_operation_function
		: found_operation.operation_function;

	// Run the HDB transaction.
	// csv loading and other jobs need to use a different postOp handler
	let result;
	try {
		if (found_operation.job_operation_function) {
			result = await operation_function(entry, js_msg.headers);
		} else {
			entry[hdb_terms.CLUSTERING_FLAG] = true;

			result = await operation_function_caller.callOperationFunctionAsAwait(
				operation_function,
				entry,
				transact_to_cluster_utilities.postOperationHandler,
				js_msg.headers
			);
		}
		harper_logger.debug(result);
	} catch (e) {
		harper_logger.error(e);
	}
*/
	// Ack to NATS to acknowledge the message has been processed
	js_msg.ack();

	return result;
}
