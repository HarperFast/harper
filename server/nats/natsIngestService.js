'use strict';

const { decode } = require('msgpackr');
const { isMainThread, parentPort, threadId } = require('worker_threads');
const natsUtils = require('./utility/natsUtils.js');
const natsTerms = require('./utility/natsTerms.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const harperLogger = require('../../utility/logging/harper_logger.js');
const envMgr = require('../../utility/environment/environmentManager.js');
const terms = require('../../utility/hdbTerms.ts');
const { onMessageByType } = require('../threads/manageThreads.js');
const cryptoHash = require('../../security/cryptoHash.js');
const { recordAction, recordActionBinary } = require('../../resources/analytics/write.ts');
const { publishToStream } = natsUtils;
const { ConsumerEvents } = require('nats');
const search = require('../../dataLayer/search.js');

const { promisify } = require('util');
const { decodeBlobsWithWrites } = require('../../resources/blob.ts');
const sleep = promisify(setTimeout);

// Max delay between attempts to connect to remote node
const MAX_REMOTE_CON_RETRY_DELAY = 10000;

let natsConnection;
let server_name;
let jsManager;
let jsClient;
let initialized;
const consumerMsgs = new Map();
const connectionStatus = new Map();

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
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.NATS_CONSUMER_UPDATE, async (message) => {
		await updateConsumer(message);
	});

	initialized = true;
	harperLogger.notify('Initializing clustering ingest service.');

	const { connection, jsm, js } = await natsUtils.getNATSReferences();
	natsConnection = connection;
	server_name = connection.info.server_name;
	jsManager = jsm;
	jsClient = js;
}

async function updateConsumer(message) {
	if (message.status === 'start') {
		const { js, jsm } = await connectToRemoteJS(message.node_domain_name);
		ingestConsumer(message.stream_name, js, jsm, message.node_domain_name);
	} else if (message.status === 'stop') {
		const consumerMsg = consumerMsgs.get(message.stream_name + message.node_domain_name);
		if (consumerMsg) {
			harperLogger.notify(
				'Closing ingest consumer for node:',
				message.node_domain_name,
				'stream:',
				message.stream_name
			);
			await consumerMsg.close?.();
			consumerMsgs.set(message.stream_name + message.node_domain_name, 'close');
		}

		if (connectionStatus.get(message.node_domain_name) === 'failed') {
			connectionStatus.set(message.node_domain_name, 'close');
		}
	}
}

const databaseSubscriptions = new Map();
function setSubscription(database, table, subscription) {
	let tableSubscriptions = databaseSubscriptions.get(database);
	if (!tableSubscriptions) databaseSubscriptions.set(database, (tableSubscriptions = new Map()));
	tableSubscriptions.set(table, subscription);
	if (!initialized) {
		initialize().then(accessConsumers);
	}
}

/**
 * This function iterates the hdbNodes entries, creates a remotes jetstream handler and initiates a listener for each consumer
 * @returns {Promise<void>}
 */
async function accessConsumers() {
	let connections = await search.searchByValue({
		database: 'system',
		table: 'hdb_nodes',
		attribute: 'name',
		value: '*',
	});

	for await (const connection of connections) {
		const domain = connection.name + natsTerms.SERVER_SUFFIX.LEAF;
		let js, jsm;
		for (const sub of connection.subscriptions || []) {
			if (sub.subscribe === true) {
				if (!js) {
					({ js, jsm } = await connectToRemoteJS(domain));
					if (!js) {
						break;
					}
				}
				const { schema, table } = sub;
				// Name of remote stream to source from
				const stream_name = cryptoHash.createNatsTableStreamName(schema, table);
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
			js = await natsConnection.jetstream({ domain });
			jsm = await natsConnection.jetstreamManager({ domain, checkAPI: false });
		} catch (err) {
			if (connectionStatus.get(domain) === 'close') break;

			connectionStatus.set(domain, 'failed');
			if (x % 10 === 1) {
				harperLogger.warn('Nats ingest attempting to connect to:', domain, 'Nats error:', err.message);
			}

			const sleepTime = x++ * 100 < MAX_REMOTE_CON_RETRY_DELAY ? x++ * 100 : MAX_REMOTE_CON_RETRY_DELAY;
			await sleep(sleepTime);
		}
	}

	return { js, jsm };
}

function getDatabaseSubscriptions() {
	return databaseSubscriptions;
}
let ignoreOrigin;
function setIgnoreOrigin(value) {
	ignoreOrigin = value;
}
const MAX_CONCURRENCY = 100;
const outstandingOperations = new Array(MAX_CONCURRENCY);
let operationIndex = 0;

/**
 * Uses an internal Nats consumer to subscribe to the stream of messages from the work queue and process each one.
 * @returns {Promise<void>}
 */
async function ingestConsumer(stream_name, js, jsm, domain) {
	const { connection } = await natsUtils.getNATSReferences();
	natsConnection = connection;
	server_name = connection.info.server_name;

	let consumer;
	let b = 1;
	while (!consumer) {
		try {
			consumer = await js.consumers.get(stream_name, server_name);
			harperLogger.notify('Initializing ingest consumer for node:', domain, 'stream:', stream_name);
		} catch (err) {
			if (connectionStatus.get(domain) === 'close') break;

			if (b % 10 === 1) {
				harperLogger.warn(
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
				harperLogger.notify('Nats ingest creating consumer for node:', domain, 'stream:', stream_name);
				consumer = await natsUtils.createConsumer(jsm, stream_name, server_name, new Date(Date.now()).toISOString());
			}
			const sleepTime = b++ * 100 < MAX_REMOTE_CON_RETRY_DELAY ? b++ * 100 : MAX_REMOTE_CON_RETRY_DELAY;
			await sleep(sleepTime);
		}
	}

	let shutdown = false;
	let messages;
	while (!shutdown) {
		if (consumerMsgs.get(stream_name + domain) === 'close' || connectionStatus.get(domain) === 'close') {
			consumerMsgs.delete(stream_name + domain);
			shutdown = true;
			continue;
		}

		messages = await consumer.consume({
			max_messages: envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_LEAFSERVER_STREAMS_MAXCONSUMEMSGS) ?? 100,
			bind: true,
		});

		consumerMsgs.set(stream_name + domain, messages);
		let calledByStop = false;

		// watch the to see if the consume operation misses heartbeats
		(async () => {
			for await (const s of await messages.status()) {
				if (s.type === ConsumerEvents.ConsumerDeleted) {
					await messages.close();
					shutdown = true;
				}

				if (s.type === ConsumerEvents.HeartbeatsMissed) {
					// you can decide how many heartbeats you are willing to miss
					const n = s.data;
					harperLogger.trace(
						`${n} clustering ingest consumer heartbeats missed, node: ${domain} stream: ${messages.consumer.stream}`
					);
					if (n === 100) {
						harperLogger.warn(
							`Restarting clustering ingest consumer due to missed heartbeat threshold being met, node: ${domain} stream: ${messages.consumer.stream}`
						);
						// by calling `stop()` the message processing loop ends.
						// in this case this is wrapped by a loop, so it attempts
						// to re-setup the consumer
						messages.stop();
						calledByStop = true;
					}
				}
			}
		})();

		try {
			for await (const message of messages) {
				// ring style queue for awaiting operations for concurrency. await the entry from 100 operations ago:
				await outstandingOperations[operationIndex];
				outstandingOperations[operationIndex] = messageProcessor(message).catch((error) => {
					harperLogger.error(error);
				});
				if (++operationIndex >= MAX_CONCURRENCY) operationIndex = 0;
			}
		} catch (err) {
			if (err.message === 'consumer deleted') {
				harperLogger.notify(
					'Nats consumer deleted, closing messages for node:',
					domain,
					'stream:',
					messages.consumer.stream
				);
				await messages.close();
				shutdown = true;
			} else {
				harperLogger.error('Error consuming clustering ingest, restarting consumer', err);
			}
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
	let entry;
	await decodeBlobsWithWrites(() => {
		entry = decode(msg.data);
	});
	recordAction(msg.data.length, 'bytes-received', msg.subject, entry.operation, 'ingest');
	harperLogger.trace('Nats message processor message size:', msg?.msg?._msg?.size, 'bytes');
	// If the msg origin header matches this node the msg can be ignored because it would have already been processed.
	let natsMsgHeader = msg.headers;
	let echoReceived = false;
	const thisNodeName = envMgr.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);
	if (natsMsgHeader.has(natsTerms.MSG_HEADERS.TRANSACTED_NODES)) {
		const txnNodes = natsMsgHeader.values(natsTerms.MSG_HEADERS.TRANSACTED_NODES);
		if (txnNodes.indexOf(thisNodeName) > -1) {
			echoReceived = true;
		}
	}

	const origin = natsMsgHeader.get(natsTerms.MSG_HEADERS.ORIGIN);
	if (!echoReceived) echoReceived = origin === thisNodeName && !ignoreOrigin;
	recordActionBinary(echoReceived, 'echo', msg.subject, entry.operation, 'ingest');

	if (echoReceived) {
		msg.ack();
		return;
	}

	natsMsgHeader.append(natsTerms.MSG_HEADERS.TRANSACTED_NODES, thisNodeName);

	try {
		let {
			operation,
			schema: databaseName,
			next: nextWrite,
			table: tableName,
			records,
			hash_values: ids,
			__origin: origin,
			expiresAt,
		} = entry;
		harperLogger.trace(
			'processing message:',
			operation,
			databaseName,
			tableName,
			(records ? 'records: ' + records.map((record) => record?.id) : '') + (ids ? 'ids: ' + ids : ''),
			'with' + ' sequence:',
			msg.seq
		);
		harperLogger.trace(`messageProcessor nats msg id: ${msg.headers.get(natsTerms.MSG_HEADERS.NATS_MSG_ID)}`);
		let onCommit;
		if (!records) records = ids;
		// Don't ack until this is completed
		let completion = new Promise((resolve) => (onCommit = resolve));
		let { timestamp, user, node_name } = origin || {};
		let subscription = databaseSubscriptions.get(databaseName)?.get(tableName);
		if (!subscription) {
			throw new Error(`Missing table for replication message: ${tableName}`);
		}
		if (operation === 'define_schema') {
			entry.type = operation;
			entry.onCommit = onCommit;
			subscription.send(entry);
		} else if (records.length === 1 && !nextWrite)
			// with a single record update, we can send this directly as a single event to our subscriber (the table
			// subscriber)
			subscription.send({
				type: convertOperation(operation),
				value: records[0],
				id: ids?.[0],
				expiresAt,
				timestamp,
				table: tableName,
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
				expiresAt,
				id: ids?.[i],
				table: tableName,
			}));
			// If there are multiple write operations, likewise, add these to transactional message we will send;
			// This happens when a transaction consists of different operations or different tables, which can't be
			// represented by simply a records array.
			while (nextWrite) {
				writes.push({
					type: convertOperation(nextWrite.operation),
					value: nextWrite.record,
					expiresAt: nextWrite.expiresAt,
					id: nextWrite.id,
					table: nextWrite.table,
				});
				nextWrite = nextWrite.next;
			}
			// send the transaction of writes that we have aggregated
			subscription.send({
				type: 'transaction',
				writes,
				table: tableName,
				timestamp,
				onCommit,
				user,
				nodeName: node_name,
			});
		}

		if (envMgr.get(terms.CONFIG_PARAMS.CLUSTERING_REPUBLISHMESSAGES) !== false) {
			// echo the message to any other nodes
			// use the already-encoded message
			publishToStream(
				msg.subject.split('.').slice(0, -1).join('.'), // remove the node name
				cryptoHash.createNatsTableStreamName(databaseName, tableName),
				msg.headers,
				msg.data
			);
		}

		await completion;
		const latency = Date.now() - timestamp;
		if (timestamp) recordAction(latency, 'replication-latency', msg.subject, operation, 'ingest');
	} catch (e) {
		harperLogger.error(e);
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
