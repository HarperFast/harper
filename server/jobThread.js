'use strict';

const hdb_terms = require('../utility/hdbTerms');
process.env[hdb_terms.PROCESS_NAME_ENV_PROP] = hdb_terms.PROCESS_DESCRIPTORS.JOB;

const harper_logger = require('../utility/logging/harper_logger');
const global_schema = require('../utility/globalSchema');
const user = require('../security/user');
const promisify = require('util').promisify;
const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);
const server_utils = require('../server/serverHelpers/serverUtilities');
const IPCClient = require('../server/ipc/IPCClient');
const p_timeout = promisify(setTimeout);
const CONNECT_TRIES = 5;
const TIMEOUT_MS = 50;

process.on('message', thread);

/**
 * function to handle running job operations in a background process
 * @param {Object} argument - the original operation sent to HDB
 * @returns {Promise<void>}
 */
async function thread(argument) {
	try {
		await p_schema_to_global();
		await user.setUsersToGlobal();

		// Instantiate new instance of HDB IPC client and assign it to global.
		try {
			// Because this client is on the job thread it doesn't need any handlers, hence the empty object param
			global.hdb_ipc = new IPCClient(process.pid, {});
		} catch (err) {
			harper_logger.error('Error instantiating new instance of IPC client in HDB job thread');
			harper_logger.error(err);
			throw err;
		}

		await waitForSocketToConnect();
		let operation = server_utils.getOperationFunction(argument);
		let results = await operation.job_operation_function(argument);
		let thread_response = { thread_results: results === undefined ? null : results };

		process.send(thread_response);
	} catch (e) {
		let e_message = e.message !== undefined ? e.message : e;
		process.send({ error: e_message, stack: e.stack });
	}
}

/**
 * tries 5 times to see if the socket connection, if there is one, is connected and authenticated
 * @returns {Promise<void>}
 */
async function waitForSocketToConnect() {
	harper_logger.info('thread socket connection waiting to connect');
	if (global.hdb_socket_client === undefined || global.hdb_socket_client.socket === undefined) {
		harper_logger.info('no thread socket connection to confirm');
		return;
	}

	let socket = global.hdb_socket_client.socket;
	if (socket.state === socket.CLOSED) {
		harper_logger.warn('thread socket connection could not connect to server');
		return;
	}

	for (let x = 0; x < CONNECT_TRIES; x++) {
		if (socket.state === socket.OPEN && socket.authState === socket.AUTHENTICATED) {
			harper_logger.info('thread socket connection successfully authenticated');
			break;
		}
		await p_timeout(TIMEOUT_MS);
	}

	harper_logger.info(`thread socket connection exiting confirmation: ${socket.state}, ${socket.authState}`);
}

module.exports = thread;
