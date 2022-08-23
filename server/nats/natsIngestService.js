'use strict';

const util = require('util');
const { toJsMsg } = require('nats');
const { decode } = require('msgpackr');
const global_schema = require('../../utility/globalSchema');
const ipc_server_handlers = require('../ipc/serverHandlers');
const nats_utils = require('./utility/natsUtils');
const nats_terms = require('./utility/natsTerms');
const hdb_terms = require('../../utility/hdbTerms');
const harper_logger = require('../../utility/logging/harper_logger');
const server_utilities = require('../serverHelpers/serverUtilities');
const IPCClient = require('../ipc/IPCClient');
const operation_function_caller = require('../../utility/OperationFunctionCaller');
const transact_to_cluster_utilities = require('../../utility/clustering/transactToClusteringUtilities');
const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);

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
 * managed by pm2. The work queue stream gets messages from other nodes. A message is a HDB transaction that was performed
 * on a remote node. This module repetitively sets up a Nats consumer on the work queue and grabs any new messages from it.
 * When it receives a new message it will decide what the HDB transaction is, and then run it locally.
 * https://docs.nats.io/nats-concepts/jetstream/streams
 * https://github.com/nats-io/nats.deno/blob/main/jetstream.md
 */

/**
 * initialized schema, ipc handler, established nats connection & jetstream handlers
 * @returns {Promise<void>}
 */
async function initialize() {
	harper_logger.notify('Starting clustering ingest service.');
	await p_schema_to_global();

	// Instantiate new instance of HDB IPC client and assign it to global.
	try {
		global.hdb_ipc = new IPCClient(process.pid, ipc_server_handlers);
	} catch (err) {
		harper_logger.error('Error instantiating new instance of IPC client in natsIngestService');
		throw err;
	}

	const { connection, jsm, js } = await nats_utils.getNATSReferences();
	nats_connection = connection;
	server_name = connection.info.server_name;
	js_manager = jsm;
	js_client = js;
}

/**
 * Uses an internal Nats consumer to subscribe to the  of messages from the work queue and process each one.
 * @returns {Promise<void>}
 */
async function workQueueListener() {
	const sub = nats_connection.subscribe(`${nats_terms.WORK_QUEUE_CONSUMER_NAMES.deliver_subject}.${server_name}`, {
		durable: nats_terms.WORK_QUEUE_CONSUMER_NAMES.durable_name,
		queue: nats_terms.WORK_QUEUE_CONSUMER_NAMES.deliver_group,
	});
	const process_sub = async () => {
		for await (const message of sub) {
			try {
				await messageProcessor(message);
			} catch (e) {
				harper_logger.error(e);
			}
		}
	};

	await process_sub();
}

/**
 * receives a message & processes it as an HDB operation
 * @param msg
 * @returns {Promise<{}>}
 */
async function messageProcessor(msg) {
	const js_msg = toJsMsg(msg);
	//tell NATS we are working on the message and not to redeliver
	js_msg.working();
	const entry = decode(js_msg.data);

	harper_logger.trace('processing message:', entry);

	// Originators are tracked to make sure a transaction doesn't get processed more than once.
	let originators = [];
	let orig = [];
	if (js_msg.headers) {
		let orig_raw = js_msg.headers.get('originators');
		if (orig_raw) {
			orig = orig_raw.split(',');
			originators = orig;
		}
	}
	let result;
	harper_logger.trace(`messageProcessor originators: ${originators} on server: ${server_name}`);
	if (originators.indexOf(server_name) < 0) {
		let operation_function = undefined;
		const found_operation = server_utilities.getOperationFunction(entry);
		operation_function = found_operation.job_operation_function
			? found_operation.job_operation_function
			: found_operation.operation_function;

		// Run the HDB transaction.
		// csv loading and other jobs need to use a different postOp handler
		try {
			if (found_operation.job_operation_function) {
				result = await operation_function(entry, originators);
			} else {
				entry[hdb_terms.CLUSTERING_FLAG] = true;

				result = await operation_function_caller.callOperationFunctionAsAwait(
					operation_function,
					entry,
					transact_to_cluster_utilities.postOperationHandler,
					originators
				);
			}
			harper_logger.debug(result);
		} catch (e) {
			harper_logger.error(e);
		}
	}

	//Ack to NATS (because the stream is a workqueue) will delete the message from the work queue stream once we have transacted it.
	js_msg.ack();
	return result;
}
