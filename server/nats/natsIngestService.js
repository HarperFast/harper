'use strict';

const { decode } = require('msgpackr');
const { isMainThread, parentPort, threadId } = require('worker_threads');
const nats_utils = require('./utility/natsUtils');
const nats_terms = require('./utility/natsTerms');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const env_mgr = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
require('../threads/manageThreads');
const crypto_hash = require('../../security/cryptoHash');
const { recordAction, recordActionBinary } = require('../../resources/analytics');
const { publishToStream } = nats_utils;
const { ConsumerEvents } = require('nats');

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
	getDatabaseSubscriptions,
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
function getDatabaseSubscriptions() {
	return database_subscriptions;
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
async function workQueueListener() {
	const consumer = await js_client.consumers.get(
		nats_terms.WORK_QUEUE_CONSUMER_NAMES.stream_name,
		nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name
	);

	let shutdown = false;
	let messages;
	parentPort?.on('message', async (message) => {
		const { type } = message;
		if (type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
			shutdown = true;
			if (messages && messages.close?.()) {
				messages.close();
			}
		}
	});

	while (!shutdown) {
		messages = await consumer.consume();

		// watch the to see if the consume operation misses heartbeats
		(async () => {
			for await (const s of await messages.status()) {
				if (s.type === ConsumerEvents.HeartbeatsMissed) {
					// you can decide how many heartbeats you are willing to miss
					const n = s.data;
					harper_logger.trace(`${n} clustering ingest consumer heartbeats missed`);
					if (n === 2) {
						harper_logger.warn('Restarting clustering ingest consumer due to missed heartbeat threshold being met');
						// by calling `stop()` the message processing loop ends.
						// in this case this is wrapped by a loop, so it attempts
						// to re-setup the consumer
						messages.stop();
					}
				}
			}
		})();

		try {
			for await (const message of messages) {
				// ring style queue for awaiting operations for concurrency. await the entry from 100 operations ago:
				await outstanding_operations[operation_index];
				outstanding_operations[operation_index] = messageProcessor(message).catch((error) => {
					harper_logger.error(error);
				});
				if (++operation_index >= MAX_CONCURRENCY) operation_index = 0;
			}
		} catch (err) {
			harper_logger.error('Error consuming clustering ingest, restarting consumer', err);
		}

		// Re-init any cached Nats client connections
		nats_utils.clearClientCache();
		await initialize();
	}
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
	const entry = decode(msg.data);
	recordAction(msg.data.length, 'bytes-received', msg.subject, entry.operation, 'ingest');

	// If the msg origin header matches this node the msg can be ignored because it would have already been processed.
	let nats_msg_header = msg.headers;
	let echo_received = false;
	const this_node_name = env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);
	if (nats_msg_header.has(nats_terms.MSG_HEADERS.TRANSACTED_NODES)) {
		const txn_nodes = nats_msg_header.values(nats_terms.MSG_HEADERS.TRANSACTED_NODES);
		if (txn_nodes.indexOf(this_node_name) > -1) {
			echo_received = true;
		}
	}

	const origin = nats_msg_header.get(nats_terms.MSG_HEADERS.ORIGIN);
	if (!echo_received) echo_received = origin === this_node_name && !ignore_origin;
	recordActionBinary(echo_received, 'echo', msg.subject, entry.operation, 'ingest');

	if (echo_received) {
		msg.ack();
		return;
	}

	nats_msg_header.append(nats_terms.MSG_HEADERS.TRANSACTED_NODES, this_node_name);

	try {
		let {
			operation,
			schema: database_name,
			next: next_write,
			table: table_name,
			records,
			hash_values: ids,
			__origin: origin,
			expiresAt: expires_at,
		} = entry;
		harper_logger.trace(
			'processing message:',
			operation,
			database_name,
			table_name,
			(records ? 'records: ' + records.map((record) => record?.id) : '') + (ids ? 'ids: ' + ids : ''),
			'with' + ' sequence:',
			msg.seq
		);
		harper_logger.trace(`messageProcessor nats msg id: ${msg.headers.get(nats_terms.MSG_HEADERS.NATS_MSG_ID)}`);
		let onCommit;
		if (!records) records = ids;
		// Don't ack until this is completed
		//let completion = new Promise((resolve) => (onCommit = resolve));
		let { timestamp, user, node_name } = origin || {};
		let subscription = database_subscriptions.get(database_name)?.get(table_name);
		if (!subscription) {
			throw new Error('Missing table for replication message', table_name);
		}
		if (operation === 'define_schema') {
			entry.type = operation;
			subscription.send(entry);
		} else if (records.length === 1 && !next_write)
			// with a single record update, we can send this directly as a single event to our subscriber (the table
			// subscriber)
			subscription.send({
				type: convertOperation(operation),
				value: records[0],
				id: ids?.[0],
				expiresAt: expires_at,
				timestamp,
				table: table_name,
				onCommit,
				user,
				nodeName: node_name,
			});
		else {
			// If there are multiple records in the transaction, we need to send a transaction event so that the
			// subscriber can persist can commit these updates transactionally
			let writes = records.map((record, i) => ({
				type: convertOperation(operation),
				value: record,
				expiresAt: expires_at,
				id: ids?.[i],
				table: table_name,
			}));
			// If there are multiple write operations, likewise, add these to transactional message we will send;
			// This happens when a transaction consists of different operations or different tables, which can't be
			// represented by simply a records array.
			while (next_write) {
				writes.push({
					type: convertOperation(next_write.operation),
					value: next_write.record,
					expiresAt: next_write.expiresAt,
					id: next_write.id,
					table: next_write.table,
				});
				next_write = next_write.next;
			}
			// send the transaction of writes that we have aggregated
			subscription.send({
				type: 'transaction',
				writes,
				table: table_name,
				timestamp,
				onCommit,
				user,
				nodeName: node_name,
			});
		}

		if (env_mgr.get(terms.CONFIG_PARAMS.CLUSTERING_REPUBLISHMESSAGES) !== false) {
			// echo the message to any other nodes
			// use the already-encoded message
			publishToStream(
				msg.subject.split('.').slice(0, -1).join('.'), // remove the node name
				crypto_hash.createNatsTableStreamName(database_name, table_name),
				msg.headers,
				msg.data
			);
		}

		//await completion;
	} catch (e) {
		harper_logger.error(e);
	}
	// Ack to NATS to acknowledge the message has been processed
	msg.ack();
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
