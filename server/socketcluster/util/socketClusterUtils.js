'use strict';

const hdb_terms = require('../../../utility/hdbTerms');
const log = require('../../../utility/logging/harper_logger');
const { inspect } = require('util');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const utils = require('../../../utility/common_utils');
const password_utility = require('../../../utility/password');
const types = require('../types');
const global_schema = require('../../../utility/globalSchema');
const read_transaction_log = require('../../../data_layer/readTransactionLog');
const ReadTransactionLogObject = require('../../../data_layer/ReadTransactionLogObject');
const { promisify } = require('util');
const url = require('url');

const SC_TOKEN_EXPIRATION = '1d';

const p_set_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);

class ConnectionDetails {
	constructor(id, host_address, host_port, state) {
		this.id = id;
		this.host_address = host_address;
		this.host_port = host_port;
		this.state = state;
		this.node_name = undefined;
		this.subscriptions = [];
	}
}

/**
 * Gets the status from the worker parameter and crams it into the status response message parameter.
 * @param worker - the worker to get status from.
 * @returns null
 */
function getWorkerStatus(worker) {
	let status_response_msg = {
		outbound_connections: [],
		inbound_connections: [],
	};
	log.trace(`getWorkerStatus`);
	try {
		if (worker.node_connector && worker.node_connector.connections && worker.node_connector.connections.clients) {
			let client_keys = Object.keys(worker.node_connector.connections.clients);
			for (let i = 0; i < client_keys.length; i++) {
				let client = worker.node_connector.connections.clients[client_keys[i]];
				let conn = new ConnectionDetails(client.id, client.options.hostname, client.options.port, client.state);
				if (client.additional_info) {
					conn['subscriptions'] = [];
					conn.node_name = client.additional_info.server_name;
					for (let x = 0; x < client.additional_info.subscriptions.length; x++) {
						let sub = client.additional_info.subscriptions[x];
						if (sub.channel.indexOf(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
							continue;
						}
						conn.subscriptions.push(sub);
					}
				}
				status_response_msg.outbound_connections.push(conn);
			}
		}
		if (worker.scServer && worker.scServer.clients) {
			let client_keys = Object.keys(worker.scServer.clients);
			for (let i = 0; i < client_keys.length; i++) {
				let client = worker.scServer.clients[client_keys[i]];
				if (
					client.remoteAddress &&
					(client.remoteAddress.includes('localhost') || client.remoteAddress.includes('127.0.0.1'))
				) {
					continue;
				}
				let query_vals = parseConnectionString(client.request.url);
				let conn = new ConnectionDetails(client.id, client.remoteAddress, client.remotePort, client.state);
				if (client.channelSubscriptions) {
					let channel_keys = Object.keys(client.channelSubscriptions);
					for (let x = 0; x < channel_keys.length; x++) {
						let sub = client.exchange._channels[channel_keys[x]];
						if (sub.name.indexOf(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX) === 0) {
							continue;
						}
						conn.subscriptions.push({ channel: sub.name, subscribe: sub.state === 'subscribed', publish: false });
						conn.node_name = query_vals.node_client_name;
					}
				}
				status_response_msg.inbound_connections.push(conn);
			}
		}

		return status_response_msg;
	} catch (err) {
		log.error(`There was an error getting worker status.`);
		log.error(err);
	}
}

/**
 * Creates a promise around an expected event and a timeout around that event.  If the event happens, the timeout will be
 * cancelled.  If it times out, we still send a resolve with the timeout message.
 * @param event_name - The name of the event we expect to get
 * @param event_emitter_object - The EventEmitter object to listen for the event on.
 * @param timeout_promise - A timeout promise object, which can be constructed with a function in common_utils.js.
 * @returns {Promise<any>}
 */
function createEventPromise(event_name, event_emitter_object, timeout_promise) {
	return new Promise((resolve) => {
		event_emitter_object.once(event_name, (msg) => {
			let curr_timeout_promise = timeout_promise;
			//timeout_promise = hdb_utils.timeoutPromise(STATUS_TIMEOUT_MS, TIMEOUT_ERR_MSG);
			log.info(`Got cluster status event response: ${inspect(msg)}`);
			try {
				curr_timeout_promise.cancel();
			} catch (err) {
				log.error('Error trying to cancel timeout.');
			}
			resolve(msg);
		});
	});
}

/**
 * Calls the Catchup class to read a specific transaction log with a time range.
 * Creates a catchup payload based on the results from Catchup and publishes to a socket
 * @returns {Promise<void>}
 */
async function schemaCatchupHandler() {
	log.trace('start schemaCatchupHandler');
	if (!global.hdb_schema) {
		try {
			await p_set_schema_to_global();
		} catch (err) {
			log.error(`Error settings schema to global.`);
			log.error(err);
			throw err;
		}
	}
	let catch_up_msg = utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
	catch_up_msg.transaction = {};
	catch_up_msg.catchup_schema = global.hdb_schema;

	return catch_up_msg;
}

/**
 * Calls the Catchup class to read a specific transaction log with a time range.
 * Creates a catchup payload based on the results from Catchup and publishes to a socket
 * @param channel
 * @param start_timestamp
 * @param end_timestamp
 * @returns {Promise<void>}
 */
async function catchupHandler(channel, start_timestamp, end_timestamp) {
	if (utils.isEmpty(channel)) {
		throw new Error('channel is required');
	}

	//we do not want to process hdb_internal channels
	if (channel.startsWith(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX)) {
		return;
	}

	let channel_split = channel.split(':');
	if (channel_split.length !== 2) {
		throw new Error('invalid channel name');
	}

	if (utils.isEmpty(end_timestamp)) {
		end_timestamp = Date.now();
	}

	if (!start_timestamp || isNaN(start_timestamp)) {
		throw new Error('invalid start_timestamp');
	}

	if (start_timestamp > end_timestamp) {
		throw new Error('end_timestamp must be greater than start_timestamp');
	}

	try {
		let read_txn_log_obj = new ReadTransactionLogObject(
			channel_split[0],
			channel_split[1],
			hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.TIMESTAMP,
			[parseInt(start_timestamp), parseInt(end_timestamp)]
		);
		log.trace(`fetch catchup: ${JSON.stringify(read_txn_log_obj)}`);
		let results = await read_transaction_log(read_txn_log_obj);
		if (Array.isArray(results) && results.length > 0) {
			let catchup_response = {
				channel: channel,
				operation: 'catchup',
				transactions: results,
			};
			let catch_up_msg = utils.getClusterMessage(hdb_terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
			catch_up_msg.transaction = catchup_response;
			catch_up_msg.__originator = {};
			catch_up_msg.__originator[env.getProperty(hdb_terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY)] =
				types.ORIGINATOR_SET_VALUE;
			return catch_up_msg;
		}
	} catch (e) {
		log.error(e);
	}
}

/**
 * send the socket a request to login, validate and process
 * @param socket
 * @param hdb_users
 */
function requestAndHandleLogin(socket, hdb_users) {
	socket.emit('login', 'send login credentials', (error, credentials) => {
		if (error) {
			console.error(error);
			return false;
		}

		if (!credentials || !credentials.username || !credentials.password) {
			console.error('Invalid credentials');
			return false;
		}

		handleLoginResponse(socket, credentials, hdb_users);
		log.info('socket successfully authenticated');
	});
}

/**
 *  Take the socket & it's credentials and match to the hdb_users
 * @param socket
 * @param credentials
 * @param hdb_users
 */
function handleLoginResponse(socket, credentials, hdb_users) {
	log.trace('handleLoginResponse');
	try {
		let found_user = hdb_users[credentials.username];

		if (found_user === undefined || !password_utility.validate(found_user.password, credentials.password)) {
			socket.destroy();
			return log.error('invalid user, access denied');
		}

		//set the JWT to expire in 1 day
		socket.setAuthToken({ username: credentials.username }, { expiresIn: SC_TOKEN_EXPIRATION });
	} catch (e) {
		log.error(e);
	}
}

/**
 * Add any relevant data from an original request into a newly created outbound message.
 * @param outbound_message - The message about to be sent
 * @param orig_req - An inbound request which may contain relevant data the outbound message needs to contain (such as originator).
 */
function concatSourceMessageHeader(outbound_message, orig_req) {
	if (!outbound_message) {
		log.error('Invalid message passed to concatSourceMessageHeader');
		return;
	}
	if (!orig_req) {
		log.error('no orig request data passed to concatSourceMessageHeader');
		return;
	}
	// TODO: Do we need to include anything else in the hdb_header?
	if (orig_req.__originator) {
		if (!outbound_message.__originator) {
			outbound_message.__originator = {};
		}
		outbound_message.__originator = orig_req.__originator;
	}
}

/**
 * Parse the connection string in socket cluster clients to extract the node_server_name and the node_client_name.
 * @param req_url - request socket url
 */
function parseConnectionString(req_url) {
	return url.parse(req_url, true).query;
}

async function setGlobalSchema() {
	try {
		await p_set_schema_to_global();
	} catch (e) {
		log.error(e);
	}
}

module.exports = {
	getWorkerStatus,
	createEventPromise,
	catchupHandler,
	schemaCatchupHandler,
	requestAndHandleLogin,
	concatSourceMessageHeader,
	parseConnectionString,
	setGlobalSchema,
	ConnectionDetails,
};
