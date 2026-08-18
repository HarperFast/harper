'use strict';

const hdbUtils = require('../../utility/common_utils.ts');
const hdbTerms = require('../../utility/hdbTerms.ts');
const { ITC_ERRORS } = require('../../utility/errors/commonErrors.ts');
const { isMainThread, parentPort, threadId, workerData } = require('worker_threads');
const harperLogger = require('../../utility/logging/harper_logger.ts');
const {
	onMessageFromWorkers,
	broadcastWithAcknowledgement,
	broadcastWithStrictAcknowledgement,
	sendToThreadWithStrictAcknowledgement,
} = require('./manageThreads.js');

module.exports = {
	sendItcEvent,
	sendItcEventStrict,
	validateEvent,
	SchemaEventMsg,
	UserEventMsg,
};
let serverItcHandlers;
const STRICT_COORDINATOR_ACK_TIMEOUT_MS = 60000;
onMessageFromWorkers(async (event, sender) => {
	const requestId = event?.requestId;
	let handlerError;
	try {
		serverItcHandlers = serverItcHandlers || require('../itc/serverHandlers.js');
		if (serverItcHandlers[event.type]) {
			const validationError = validateEvent(event);
			if (validationError) throw new Error(validationError);
			await serverItcHandlers[event.type](event);
		}
		if (event.relayStrictToWorkers && isMainThread) {
			const relayedEvent = { ...event, relayStrictToWorkers: false, requestId: undefined };
			await broadcastWithStrictAcknowledgement(relayedEvent);
		}
	} catch (error) {
		handlerError = error;
	}
	if (handlerError) harperLogger.error('ITC event handler failed', handlerError);
	if (requestId && sender) {
		try {
			sender.postMessage({
				type: 'ack',
				id: requestId,
				...(handlerError && {
					error: {
						message: handlerError.message ?? String(handlerError),
						code: handlerError.code,
					},
				}),
			});
		} catch (error) {
			harperLogger.error('Unable to acknowledge ITC event', error);
		}
	}
});
if (!isMainThread) {
	if (workerData?.itcReadyBuffer) Atomics.store(new Int32Array(workerData.itcReadyBuffer), 0, 1);
	parentPort?.postMessage({ type: hdbTerms.ITC_EVENT_TYPES.ITC_READY });
}

/**
 * Emits an ITC event to the ITC server.
 * @param event
 */
function sendItcEvent(event) {
	stampOriginator(event);
	return broadcastWithAcknowledgement(event);
}

function sendItcEventStrict(event) {
	stampOriginator(event);
	if (isMainThread) return broadcastWithStrictAcknowledgement(event);
	event.relayStrictToWorkers = true;
	// The main thread first prepares itself and then runs its own 30-second worker broadcast.
	// The worker-to-main deadline must cover both phases rather than racing the nested deadline.
	return sendToThreadWithStrictAcknowledgement(0, event, STRICT_COORDINATOR_ACK_TIMEOUT_MS);
}

function stampOriginator(event) {
	// Always stamp originator so handlers can send direct responses back.
	// The main thread's threadId is 0 (worker_threads convention); parentPort.threadId
	// is set to 0 in workers, so sendToThread(0, ...) routes back to main.
	if (event.message) event.message.originator = threadId;
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
