'use strict';

const envManager = require('../../utility/environment/environmentManager.js');
envManager.initSync();

const natsUtils = require('./utility/natsUtils.js');
const harperLogger = require('../../utility/logging/harper_logger.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const natsTerms = require('./utility/natsTerms.js');
const updateRemoteSource = require('../../utility/clustering/updateRemoteSource.js');
const removeRemoteSource = require('../../utility/clustering/removeRemoteSource.js');
const getRemoteSourceConfig = require('../../utility/clustering/getRemoteSourceConfig.js');
const UpdateRemoteResponseObject = require('../../utility/clustering/UpdateRemoteResponseObject.js');
const { encode, decode } = require('msgpackr');
const globalSchema = require('../../utility/globalSchema.js');
const schemaDescribe = require('../../dataLayer/schemaDescribe.js');
const util = require('util');
const terms = require('../../utility/hdbTerms.ts');
const { isMainThread, parentPort } = require('worker_threads');
require('../threads/manageThreads.js');

const pSchemaToGlobal = util.promisify(globalSchema.setSchemaDataToGlobal);
const node_name = envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME);

module.exports = initialize;

/**
 * This module is designed to handle requests from other nodes, such as add, update or delete node.
 * It runs in its own process managed by processManagement.
 * The nats connection is what keeps the process open/running.
 * @returns {Promise<void>}
 */
async function initialize() {
	try {
		harperLogger.notify('Starting reply service.');
		await pSchemaToGlobal();

		const connection = await natsUtils.getConnection();
		const subjectName = `${node_name}.__request__`;

		// We define a queue name to allow multiple processes to subscribe to the same subject but only one process will receive the message.
		// This allows for scale, more on queue groups here: https://github.com/nats-io/nats.js#queue-groups
		const sub = connection.subscribe(subjectName, { queue: node_name });
		await handleRequest(sub);
	} catch (err) {
		harperLogger.error(err);
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
		const msgData = decode(msg.data);
		let reply;

		switch (msgData.operation) {
			case hdbTerms.OPERATIONS_ENUM.ADD_NODE:
			case hdbTerms.OPERATIONS_ENUM.UPDATE_NODE:
				reply = await updateRemoteSource(msgData);
				break;
			case hdbTerms.OPERATIONS_ENUM.REMOVE_NODE:
				reply = await removeRemoteSource(msgData);
				break;
			case hdbTerms.OPERATIONS_ENUM.CLUSTER_STATUS:
				reply = await getRemoteSourceConfig(msgData);
				break;
			case hdbTerms.OPERATIONS_ENUM.DESCRIBE_ALL:
				reply = await getRemoteDescribeAll();
				break;
			default:
				const errMsg = `node '${node_name}' reply service received unrecognized request operation`;
				harperLogger.error(errMsg);
				reply = new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, errMsg);
		}

		harperLogger.trace(reply);
		msg.respond(encode(reply));
	}
}

async function getRemoteDescribeAll() {
	try {
		return {
			status: natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS,
			message: await schemaDescribe.describeAll({ bypass_auth: true }),
		};
	} catch (err) {
		harperLogger.error(err);

		return {
			status: natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR,
			message: err.message,
		};
	}
}
if (!isMainThread) {
	parentPort.on('message', async (message) => {
		const { type } = message;
		if (type === terms.ITC_EVENT_TYPES.SHUTDOWN) {
			natsUtils.closeConnection();
		}
	});
}
