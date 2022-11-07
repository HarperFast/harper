'use strict';

const {isMainThread, parentPort} = require("worker_threads");
const {Socket} = require("net");
const harper_logger = require('../../utility/logging/harper_logger');
const hdb_utils = require("../../utility/common_utils");
const env = require("../../utility/environment/environmentManager");
const terms = require("../../utility/hdbTerms");
// log all threads as HarperDB
harper_logger.createLogFile(terms.PROCESS_LOG_NAMES.HDB, terms.HDB_PROC_DESCRIPTOR);
env.initSync();
const SERVERS = {};
module.exports = {
	registerServer,
};
if (!isMainThread) {
	require('../harperdb/hdbServer').hdbServer();
	const custom_func_enabled = env.get(terms.HDB_SETTINGS_NAMES.CUSTOM_FUNCTIONS_ENABLED_KEY);
	if (custom_func_enabled) require('../customFunctions/customFunctionsServer').customFunctionsServer();

	parentPort.on('message', (message) => {
		const {type, fd} = message;
		if (fd) {
			// Create a socket from the file descriptor for the socket that was routed to us. HTTP server likes to
			// allow half open sockets
			let socket = new Socket({fd, readable: true, writable: true, allowHalfOpen: true});
			// for each socket, deliver the connection to the HTTP server handler/parser
			if (SERVERS[type]) SERVERS[type].emit('connection', socket);
			else harper_logger.error(`Server ${type} was not registered`);
		}
	});
}

function registerServer(type, server) {
	SERVERS[type] = server;
}