import * as hdbUtils from '../../utility/common_utils.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import { ITC_ERRORS } from '../../utility/errors/commonErrors.ts';
import { threadId, isMainThread } from 'worker_threads';
import { onMessageFromWorkers, broadcastWithAcknowledgement } from './manageThreads.ts';

export { sendItcEvent, validateEvent, SchemaEventMsg, UserEventMsg };
let serverItcHandlers;
// Defer registration so manageThreads.ts is fully evaluated when we read from
// it (ESM cycle would otherwise leave its internal state uninitialized).
setImmediate(() => {
	onMessageFromWorkers(async (event, sender) => {
		if (!serverItcHandlers) {
			const m: any = await import('../itc/serverHandlers.ts');
			// Dynamic import returns the namespace { default: handlersObj }; in
			// CJS-dist it can be double-wrapped as { default: { default: ... } }.
			serverItcHandlers = m.default?.default ?? m.default ?? m;
		}
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
