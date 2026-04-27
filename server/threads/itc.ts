'use strict';;
import * as hdbUtils from '../../utility/common_utils.js';
import * as hdbTerms from '../../utility/hdbTerms.js';
import { ITC_ERRORS } from '../../utility/errors/commonErrors.js';
import { threadId, isMainThread } from 'node:worker_threads';
import { broadcastWithAcknowledgement } from './manageThreads.js';
import { onMessageFromWorkers } from './threadEvents.js';

export {
	sendItcEvent,
	validateEvent,
	SchemaEventMsg,
	UserEventMsg,
};

let serverItcHandlers: any;
onMessageFromWorkers(async (event: any, sender: any) => {
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
function sendItcEvent(event: any) {
	if (!isMainThread && event.message) event.message.originator = threadId;
	return broadcastWithAcknowledgement(event);
}

/**
 * Does some basic validation on an ITC event.
 * @param event
 * @returns {string}
 */
function validateEvent(event: any) {
	if (typeof event !== 'object') {
		return ITC_ERRORS.INVALID_ITC_DATA_TYPE;
	}

	if (!Object.prototype.hasOwnProperty.call(event, 'type') || hdbUtils.isEmpty(event.type)) {
		return ITC_ERRORS.MISSING_TYPE;
	}

	if (!Object.prototype.hasOwnProperty.call(event, 'message') || hdbUtils.isEmpty(event.message)) {
		return ITC_ERRORS.MISSING_MSG;
	}

	if (!Object.prototype.hasOwnProperty.call(event.message, 'originator') || hdbUtils.isEmpty(event.message.originator)) {
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
 * @constructor
 */
export class SchemaEventMsg {
	originator: any;
	operation: any;
	schema: any;
	table: any;
	attribute: any;
	constructor(originator, operation, schema, table = undefined, attribute = undefined) {
		this.originator = originator;
		this.operation = operation;
		this.schema = schema;
		this.table = table;
		this.attribute = attribute;
	}
}

/**
 * Constructor function for the message of user ITC events
 * @param originator
 * @constructor
 */
export class UserEventMsg {
	originator: any;
	constructor(originator) {
		this.originator = originator;
	}
}
