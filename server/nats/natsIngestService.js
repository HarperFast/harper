'use strict';

const { toJsMsg } = require('nats');
const { decode } = require('msgpackr');
const { isMainThread, parentPort } = require('worker_threads');
const nats_utils = require('./utility/natsUtils');
const nats_terms = require('./utility/natsTerms');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const env_mgr = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
require('../threads/manageThreads');
const crypto_hash = require('../../security/cryptoHash');
const { publishToStream } = nats_utils;

const SUBSCRIPTION_OPTIONS = {
	durable: nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name,
	queue: nats_terms.WORK_QUEUE_CONSUMER_NAMES.deliver_group,
};

let nats_connection;
let server_name;
let js_manager;
let js_client;
let initialized;

module.exports = {
	initialize,
	workQueueListener,
	setSubscription,
	setIgnoreOrigin,
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
	initialized = true;
	harper_logger.notify('Starting clustering ingest service.');

	const { connection, jsm, js } = await nats_utils.getNATSReferences();
	nats_connection = connection;
	server_name = connection.info.server_name;
	js_manager = jsm;
	js_client = js;
}
const database_subscriptions = new Map();
function setSubscription(database, table, subscription) {
	let table_subscriptions = database_subscriptions.get(database);
	if (!table_subscriptions) database_subscriptions.set(database, (table_subscriptions = new Map()));
	table_subscriptions.set(table, subscription);
	if (!initialized) {
		initialize().then(workQueueListener);
	}
}
let ignore_origin;
function setIgnoreOrigin(value) {
	ignore_origin = value;
}
const MAX_CONCURRENCY = 100;
const outstanding_operations = new Array(MAX_CONCURRENCY);
let operation_index = 0;
/**
 * Uses an internal Nats consumer to subscribe to the stream of messages from the work queue and process each one.
 * @returns {Promise<void>}
 */
async function workQueueListener(signal) {
	const sub = nats_connection.subscribe(
		`${nats_terms.WORK_QUEUE_CONSUMER_NAMES.deliver_subject}.${nats_connection.info.server_name}`,
		SUBSCRIPTION_OPTIONS
	);
	if (signal) signal.abort = () => sub.close();

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
 * Processes a message from the NATS work queue and delivers to through the table subscription to the NATS
 * cluster which effectively acts as a source for tables. When a table makes a subscriptions, the subscription
 * events are considered to be notifications; they don't go through higher level put/delete/publish methods
 * because they should not go through validation or user-defined logic, they represent after-the-fact replication
 * of updates that have already been made. This also means that subscription events are written at a lower level
 * than the source delegation where replication occurs, which nicely avoids echoing to subscription events to
 * sources. However, in NATS we are actually using echo to (potentially) route messages to other nodes. So we
 * actually perform the echo in here. This has the advantage of being able to reuse the encoded message and
 * encapsulating the header information.
 * @param msg
 * @returns {Promise<{}>}
 */
async function messageProcessor(msg) {
	const js_msg = toJsMsg(msg);
	const entry = decode(js_msg.data);

	// If the msg origin header matches this node the msg can be ignored because it would have already been processed.
	let nats_msg_header = js_msg.headers;
	const origin = nats_msg_header.get(nats_terms.MSG_HEADERS.ORIGIN);
	if (origin === env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME) && !ignore_origin) {
		js_msg.ack();
		return;
	}

	harper_logger.trace('processing message:', entry, 'with sequence:', js_msg.seq);
	harper_logger.trace(`messageProcessor nats msg id: ${js_msg.headers.get(nats_terms.MSG_HEADERS.NATS_MSG_ID)}`);
	try {
		let {
			operation,
			schema: database_name,
			next: next_write,
			table: table_name,
			records,
			ids,
			writes,
			__origin,
		} = entry;
		let onCommit;
		if (!records) records = ids;
		let completion = new Promise((resolve) => (onCommit = resolve));
		let { timestamp, user } = __origin || {};
		let subscription = database_subscriptions.get(database_name)?.get(table_name);
		if (!subscription) {
			throw new Error('Missing table for replication message', table_name);
		}
		if (records.length === 1 && !next_write)
			subscription.send({
				operation: convertOperation(operation),
				value: records[0],
				timestamp,
				table: table_name,
				onCommit,
				__origin,
			});
		else {
			let writes = records.map((record) => ({
				operation: convertOperation(operation),
				value: record,
			}));
			while (next_write) {
				writes.push({
					operation: next_write.operation,
					value: next_write.record,
					table: next_write.table,
				});
				next_write = next_write.next;
			}

			subscription.send({
				operation: 'transaction',
				writes,
				table: table_name,
				timestamp,
				onCommit,
				__origin,
			});
		}
		// echo the message to any other nodes
		publishToStream(
			msg.subject.split('.').slice(0, -1).join('.'), // remove the node name
			crypto_hash.createNatsTableStreamName(database_name, table_name),
			js_msg.headers,
			js_msg.data
		); // use the already-encoded message
		// onCommit is not being called, but not sure if we really need to do this
		// await completion;
	} catch (e) {
		harper_logger.error(e);
	}
	// Ack to NATS to acknowledge the message has been processed
	js_msg.ack();
}
function convertOperation(operation) {
	switch (operation) {
		case 'insert':
		case 'upsert':
		case 'update':
			return 'put';
	}
	return operation;
}
