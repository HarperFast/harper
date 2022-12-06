'use strict';

const hdb_logger = require('../../utility/logging/harper_logger');
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const { IPC_ERRORS } = require('../../utility/errors/commonErrors');
const { parentPort, threadId, isMainThread } = require('worker_threads');

module.exports = {
	sendItcEvent,
	validateEvent,
	SchemaEventMsg,
	UserEventMsg,
};
const thread_ports = [];
if (parentPort) {
	parentPort.on('message', (parent_message) => {
		const server_ipc_handlers = require('../ipc/serverHandlers');
		if (parent_message.type === hdb_terms.IPC_EVENT_TYPES.ADD_PORT) {
			thread_ports.push(parent_message.port);
			parent_message.port.on('message', (event) => {
				validateEvent(event);
				if (server_ipc_handlers[event.type])
					server_ipc_handlers[event.type](event);
			}).unref();
		}
	}).unref();
}

/**
 * Emits an IPC event to the IPC server.
 * @param event
 */
function sendItcEvent(event) {
	if (!isMainThread && event.message) event.message.originator = threadId;
	for (let port of thread_ports) {
		port.postMessage(event);
	}
	if (global.hdb_ipc) {
		global.hdb_ipc.emitToServer(event);
	} else {
		hdb_logger.warn(`Tried to send event:`, event, `to HDB IPC client but it does not exist`);
	}
}

/**
 * Does some basic validation on an IPC event.
 * @param event
 * @returns {string}
 */
function validateEvent(event) {
	if (typeof event !== 'object') {
		return IPC_ERRORS.INVALID_IPC_DATA_TYPE;
	}

	if (!event.hasOwnProperty('type') || hdb_utils.isEmpty(event.type)) {
		return IPC_ERRORS.MISSING_TYPE;
	}

	if (!event.hasOwnProperty('message') || hdb_utils.isEmpty(event.message)) {
		return IPC_ERRORS.MISSING_MSG;
	}

	if (!event.message.hasOwnProperty('originator') || hdb_utils.isEmpty(event.message.originator)) {
		return IPC_ERRORS.MISSING_ORIGIN;
	}

	if (hdb_terms.IPC_EVENT_TYPES[event.type.toUpperCase()] === undefined) {
		return IPC_ERRORS.INVALID_EVENT(event.type);
	}
}

/**
 * Constructor function for the message of schema IPC events
 * @param originator
 * @param operation
 * @param schema
 * @param table
 * @param attribute
 * @constructor
 */
function SchemaEventMsg(originator, operation, schema, table = undefined, attribute = undefined) {
	this.originator = originator;
	this.operation = operation;
	this.schema = schema;
	this.table = table;
	this.attribute = attribute;
}

/**
 * Constructor function for the message of user IPC events
 * @param originator
 * @constructor
 */
function UserEventMsg(originator) {
	this.originator = originator;
}
