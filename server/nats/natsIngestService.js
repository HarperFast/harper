'use strict';

const { decode } = require('msgpackr');
const { isMainThread, parentPort, threadId } = require('worker_threads');
const nats_utils = require('./utility/natsUtils');
const nats_terms = require('./utility/natsTerms');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const env_mgr = require('../../utility/environment/environmentManager');
const terms = require('../../utility/hdbTerms');
const { onMessageByType } = require('../threads/manageThreads');
const crypto_hash = require('../../security/cryptoHash');
const { recordAction, recordActionBinary } = require('../../resources/analytics');
const { publishToStream } = nats_utils;
const { ConsumerEvents } = require('nats');
const search = require('../../dataLayer/search');

const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Max delay between attempts to connect to remote node
const MAX_REMOTE_CON_RETRY_DELAY = 10000;

let nats_connection;
let server_name;
let js_manager;
let js_client;
let initialized;
const consumer_msgs = new Map();
const connection_status = new Map();

module.exports = {
	initialize,
	ingestConsumer,
	setSubscription,
	setIgnoreOrigin,
	getDatabaseSubscriptions,
	updateConsumer,
};

/**
 * initialized schema, itc handler, established nats connection & jetstream handlers
 * @returns {Promise<void>}
 */
async function initialize() {
	onMessageByType(hdb_terms.ITC_EVENT_TYPES.NATS_CONSUMER_UPDATE, async (message) => {
		await updateConsumer(message);
	});

	initialized = true;
	harper_logger.notify('Initializing clustering ingest service.');

	const { connection, jsm, js } = await nats_utils.getNATSReferences();
	nats_connection = connection;
	server_name = connection.info.server_name;
	js_manager = jsm;
	js_client = js;
}

async function updateConsumer(message) {
	if (message.status === 'start') {
		const { js, jsm } = await connectToRemoteJS(message.node_domain_name);
		ingestConsumer(message.stream_name, js, jsm, message.node_domain_name);
	} else if (message.status === 'stop') {
		const consumer_msg = consumer_msgs.get(message.stream_name + message.node_domain_name);
		if (consumer_msg) {
			harper_logger.notify(
				'Closing ingest consumer for node:',
				message.node_domain_name,
				'stream:',
				message.stream_name
			);
			await consumer_msg.close?.();
			consumer_msgs.set(message.stream_name + message.node_domain_name, 'close');
		}

		if (connection_status.get(message.node_domain_name) === 'failed') {
			connection_status.set(message.node_domain_name, 'close');
		}
	}
}

const database_subscriptions = new Map();
function setSubscription(database, table, subscription) {
	let table_subscriptions = database_subscriptions.get(database);
	if (!table_subscriptions) database_subscriptions.set(database, (table_subscriptions = new Map()));
	table_subscriptions.set(table, subscription);
	if (!initialized) {
		initialize().then(accessConsumers);
	}
}

/**
 * This function iterates the hdb_nodes entries, creates a remotes jetstream handler and initiates a listener for each consumer
 * @returns {Promise<void>}
 */
async function accessConsumers() {
	let connections = await search.searchByValue({
		database: 'system',
		table: 'hdb_nodes',
		search_attribute: 'name',
		search_value: '*',
	});

	for await (const connection of connections) {
		const domain = connection.name + nats_terms.SERVER_SUFFIX.LEAF;
		let js, jsm;
		for (const sub of connection.subscriptions) {
			if (sub.subscribe === true) {
				if (!js) {
					({ js, jsm } = await connectToRemoteJS(domain));
					if (!js) {
						break;
					}
				}
				const { schema, table } = sub;
				// Name of remote stream to source from
				const stream_name = crypto_hash.createNatsTableStreamName(schema, table);
				ingestConsumer(stream_name, js, jsm, domain);
			}
		}
	}
}

/**
 * connects to a remote nodes jetstream
 * @param domain
 * @returns {Promise<{jsm: undefined, js}>}
 */
async function connectToRemoteJS(domain) {
	let js, jsm;
	let x = 1;
	while (!jsm) {
		try {
			js = await nats_connection.jetstream({ domain });
			jsm = await nats_connection.jetstreamManager({ domain });
		} catch (err) {
			if (connection_status.get(domain) === 'close') break;

			connection_status.set(domain, 'failed');
			if (x % 10 === 1) {
				harper_logger.warn('Nats ingest attempting to connect to:', domain, 'Nats error:', err.message);
			}

			const sleep_time = x++ * 100 < MAX_REMOTE_CON_RETRY_DELAY ? x++ * 100 : MAX_REMOTE_CON_RETRY_DELAY;
			await sleep(sleep_time);
		}
	}

	return { js, jsm };
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
async function ingestConsumer(stream_name, js, jsm, domain) {
	const { connection } = await nats_utils.getNATSReferences();
	nats_connection = connection;
	server_name = connection.info.server_name;

	let consumer;
	let b = 1;
	while (!consumer) {
		try {
			consumer = await js.consumers.get(stream_name, server_name);
			harper_logger.notify('Initializing ingest consumer for node:', domain, 'stream:', stream_name);
		} catch (err) {
			if (connection_status.get(domain) === 'close') break;

			if (b % 10 === 1) {
				harper_logger.warn(
					'Nats ingest error getting consumer:',
					domain,
					'stream:',
					stream_name,
					'Nats error:',
					err.message
				);
			}

			// If there is no consumer on the remote node, create one. This can occur when the remote node is on an older HDB version.
			if (err.code === '404') {
				harper_logger.notify('Nats ingest creating consumer for node:', domain, 'stream:', stream_name);
				consumer = await nats_utils.createConsumer(jsm, stream_name, server_name, new Date(Date.now()).toISOString());
			}
			const sleep_time = b++ * 100 < MAX_REMOTE_CON_RETRY_DELAY ? b++ * 100 : MAX_REMOTE_CON_RETRY_DELAY;
			await sleep(sleep_time);
		}
	}

	let shutdown = false;
	let messages;
	while (!shutdown) {
		if (consumer_msgs.get(stream_name + domain) === 'close' || connection_status.get(domain) === 'close') {
			consumer_msgs.delete(stream_name + domain);
			shutdown = true;
			continue;
		}

		messages = await consumer.consume({
			max_messages: env_mgr.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXCONSUMEMSGS) ?? 100,
		});

		consumer_msgs.set(stream_name + domain, messages);
		let called_by_stop = false;

		// watch the to see if the consume operation misses heartbeats
		(async () => {
			for await (const s of await messages.status()) {
				if (s.type === ConsumerEvents.HeartbeatsMissed) {
					// you can decide how many heartbeats you are willing to miss
					const n = s.data;
					harper_logger.trace(
						`${n} clustering ingest consumer heartbeats missed, node: ${domain} stream: ${messages.consumer.stream}`
					);
					if (n === 2) {
						harper_logger.warn(
							`Restarting clustering ingest consumer due to missed heartbeat threshold being met, node: ${domain} stream: ${messages.consumer.stream}`
						);
						// by calling `stop()` the message processing loop ends.
						// in this case this is wrapped by a loop, so it attempts
						// to re-setup the consumer
						messages.stop();
						called_by_stop = true;
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
			if (err.message === 'consumer deleted') {
				harper_logger.notify(
					'Nats consumer deleted, closing messages for node:',
					domain,
					'stream:',
					messages.consumer.stream
				);
				await messages.close();
				shutdown = true;
			} else {
				harper_logger.error('Error consuming clustering ingest, restarting consumer', err);
			}
		}

		// Re-init any cached Nats client connections
		nats_utils.clearClientCache();

		if (!shutdown && called_by_stop) {
			await initialize();
		}
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
	harper_logger.trace('Nats message processor message size:', msg?.msg?._msg?.size, 'bytes');
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
		let completion = new Promise((resolve) => (onCommit = resolve));
		let { timestamp, user, node_name } = origin || {};
		let subscription = database_subscriptions.get(database_name)?.get(table_name);
		if (!subscription) {
			throw new Error('Missing table for replication message', table_name);
		}
		if (operation === 'define_schema') {
			entry.type = operation;
			entry.onCommit = onCommit;
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

		await completion;
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
