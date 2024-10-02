'use strict';

const env_manager = require('../../utility/environment/environmentManager');
env_manager.initSync();

const nats_utils = require('./utility/natsUtils');
const harper_logger = require('../../utility/logging/harper_logger');
const hdb_terms = require('../../utility/hdbTerms');
const nats_terms = require('./utility/natsTerms');
const update_remote_source = require('../../utility/clustering/updateRemoteSource');
const remove_remote_source = require('../../utility/clustering/removeRemoteSource');
const get_remote_source_config = require('../../utility/clustering/getRemoteSourceConfig');
const UpdateRemoteResponseObject = require('../../utility/clustering/UpdateRemoteResponseObject');
const { encode, decode } = require('msgpackr');
const global_schema = require('../../utility/globalSchema');
const schema_describe = require('../../dataLayer/schemaDescribe');
const util = require('util');
const terms = require('../../utility/hdbTerms');
const { isMainThread, parentPort } = require('worker_threads');
require('../threads/manageThreads');

const p_schema_to_global = util.promisify(global_schema.setSchemaDataToGlobal);
const node_name = env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = initialize;

/**
 * This module is designed to handle requests from other nodes, such as add, update or delete node.
 * It runs in its own process managed by processManagement.
 * The nats connection is what keeps the process open/running.
 * @returns {Promise<void>}
 */
async function initialize() {
	try {
		harper_logger.notify('Starting reply service.');
		await p_schema_to_global();

		const connection = await nats_utils.getConnection();
		const subject_name = `${node_name}.__request__`;

		// We define a queue name to allow multiple processes to subscribe to the same subject but only one process will receive the message.
		// This allows for scale, more on queue groups here: https://github.com/nats-io/nats.js#queue-groups
		const sub = connection.subscribe(subject_name, { queue: node_name });
		await handleRequest(sub);
	} catch (err) {
		harper_logger.error(err);
	}
}

/**
 * Handle the request coming in from other node.
 * Once the operation in the request has completed respond to originator.
 * If something goes wrong during the operation we try to respond but with an error status.
 * @param sub
 * @returns {Promise<void>}
 */
async function handleRequest(sub) {
	for await (const msg of sub) {
		const msg_data = decode(msg.data);
		let reply;

		switch (msg_data.operation) {
			case hdb_terms.OPERATIONS_ENUM.ADD_NODE:
			case hdb_terms.OPERATIONS_ENUM.UPDATE_NODE:
				reply = await update_remote_source(msg_data);
				break;
			case hdb_terms.OPERATIONS_ENUM.REMOVE_NODE:
				reply = await remove_remote_source(msg_data);
				break;
			case hdb_terms.OPERATIONS_ENUM.CLUSTER_STATUS:
				reply = await get_remote_source_config(msg_data);
				break;
			case hdb_terms.OPERATIONS_ENUM.DESCRIBE_ALL:
				reply = await getRemoteDescribeAll();
				break;
			default:
				const err_msg = `node '${node_name}' reply service received unrecognized request operation`;
				harper_logger.error(err_msg);
				reply = new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, err_msg);
		}

		harper_logger.trace(reply);
		msg.respond(encode(reply));
	}
}

async function getRemoteDescribeAll() {
	try {
		return {
			status: nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS,
			message: await schema_describe.describeAll({ bypass_auth: true }),
		};
	} catch (err) {
		harper_logger.error(err);

		return {
			status: nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR,
			message: err.message,
		};
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
