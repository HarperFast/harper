'use strict';

const hdbUtils = require('../../utility/common_utils.ts');
const hdbTerms = require('../../utility/hdbTerms.ts');
const { ITC_ERRORS } = require('../../utility/errors/commonErrors.ts');
const { threadId } = require('worker_threads');
const { onMessageFromWorkers, broadcastWithAcknowledgement } = require('./manageThreads.js');

module.exports = {
	sendItcEvent,
	validateEvent,
	SchemaEventMsg,
	UserEventMsg,
};
let serverItcHandlers;
onMessageFromWorkers(async (event, sender) => {
	serverItcHandlers = serverItcHandlers || require('../itc/serverHandlers.js');
	validateEvent(event);
	if (serverItcHandlers[event.type]) {
		await serverItcHandlers[event.type](event);
	}
	if (event.requestId && sender)
		sender.postMessage({
			type: 'ack',
			id: event.requestId,
		});
});

/**
 * Emits an ITC event to the ITC server.
 * @param event
 */
function sendItcEvent(event) {
	// Always stamp originator so handlers can send direct responses back.
	// The main thread's threadId is 0 (worker_threads convention); parentPort.threadId
	// is set to 0 in workers, so sendToThread(0, ...) routes back to main.
	if (event.message) event.message.originator = threadId;
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

	if (!event.hasOwnProperty('type') || hdbUtils.isEmpty(event.type)) {
		return ITC_ERRORS.MISSING_TYPE;
	}

	if (!event.hasOwnProperty('message') || hdbUtils.isEmpty(event.message)) {
		return ITC_ERRORS.MISSING_MSG;
	}

	if (!event.message.hasOwnProperty('originator') || hdbUtils.isEmpty(event.message.originator)) {
		return ITC_ERRORS.MISSING_ORIGIN;
	}

	if (hdbTerms.ITC_EVENT_TYPES[event.type.toUpperCase()] === undefined) {
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
 * @param branchPath the branch directory when the change is to a scope-private branch of `schema`
 *   rather than to the database itself (resources/databases.ts `reloadBranchAt`)
 * @constructor
 */
function SchemaEventMsg(
	originator,
	operation,
	schema,
	table = undefined,
	attribute = undefined,
	branchPath = undefined
) {
	this.originator = originator;
	this.operation = operation;
	this.schema = schema;
	this.table = table;
	this.attribute = attribute;
	if (branchPath) this.branchPath = branchPath;
}

/**
 * Constructor function for the message of user ITC events
 * @param originator
 * @constructor
 */
function UserEventMsg(originator) {
	this.originator = originator;
}
