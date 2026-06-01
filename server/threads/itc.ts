import * as hdbTerms from '../../utility/hdbTerms.ts';
// Inline isEmpty to break the common_utils→databases→itc→common_utils circular dep.
const isEmpty = (value: unknown) => value === undefined || value === null;
import { ITC_ERRORS } from '../../utility/errors/commonErrors.ts';
import { threadId } from 'worker_threads';
import {
	onMessageFromWorkers,
	broadcastWithAcknowledgement as _broadcastWithAcknowledgement,
} from './manageThreads.ts';
// Rewire-compat alias: unit tests inject `broadcastWithAcknowledgement` by name via rewire __set__
let broadcastWithAcknowledgement = _broadcastWithAcknowledgement;

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

	if (!event.hasOwnProperty('type') || isEmpty(event.type)) {
		return ITC_ERRORS.MISSING_TYPE;
	}

	if (!event.hasOwnProperty('message') || isEmpty(event.message)) {
		return ITC_ERRORS.MISSING_MSG;
	}

	if (!event.message.hasOwnProperty('originator') || isEmpty(event.message.originator)) {
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
