'use strict';

const hdb_logger = require('../../utility/logging/harper_logger');
const hdb_utils = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const { ITC_ERRORS } = require('../../utility/errors/commonErrors');
const { parentPort, threadId, isMainThread, workerData } = require('worker_threads');
const { onMessageFromWorkers, broadcast, broadcastWithAcknowledgement } = require('./manageThreads');

module.exports = {
	sendItcEvent,
	validateEvent,
	SchemaEventMsg,
	UserEventMsg,
};
let server_itc_handlers;
onMessageFromWorkers(async (event, sender) => {
	server_itc_handlers = server_itc_handlers || require('../itc/serverHandlers');
	validateEvent(event);
	if (server_itc_handlers[event.type]) {
		await server_itc_handlers[event.type](event);
		if (event.requestId && sender)
			sender.postMessage({
				type: 'ack',
				id: event.requestId,
			});
	}
});

/**
 * Emits an ITC event to the ITC server.
 * @param event
 */
function sendItcEvent(event) {
	if (!isMainThread && event.message) event.message.originator = threadId;
	return broadcastWithAcknowledgement(event);
}

/**
 * Does some basic validation on an ITC event.
 * @param event
 * @returns {string}
 */
function validateEvent(event) {
	if (typeof event !== 'object') {
		return ITC_ERRORS.INVALID_ITC_DATA_TYPE;
	}

	if (!event.hasOwnProperty('type') || hdb_utils.isEmpty(event.type)) {
		return ITC_ERRORS.MISSING_TYPE;
	}

	if (!event.hasOwnProperty('message') || hdb_utils.isEmpty(event.message)) {
		return ITC_ERRORS.MISSING_MSG;
	}

	if (!event.message.hasOwnProperty('originator') || hdb_utils.isEmpty(event.message.originator)) {
		return ITC_ERRORS.MISSING_ORIGIN;
	}

	if (hdb_terms.ITC_EVENT_TYPES[event.type.toUpperCase()] === undefined) {
		return ITC_ERRORS.INVALID_EVENT(event.type);
	}
}

/**
 * Constructor function for the message of schema ITC events
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
 * Constructor function for the message of user ITC events
 * @param originator
 * @constructor
 */
function UserEventMsg(originator) {
	this.originator = originator;
}
