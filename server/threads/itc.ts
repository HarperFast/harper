import * as hdbUtils from '../../utility/common_utils.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import { ITC_ERRORS } from '../../utility/errors/commonErrors.ts';
import { threadId } from 'worker_threads';
import { onMessageFromWorkers, broadcastWithAcknowledgement } from './manageThreads.ts';

export { sendItcEvent, validateEvent, SchemaEventMsg, UserEventMsg };
let serverItcHandlers;
// Kick off serverHandlers resolution at module load so it's likely settled by
// the time the first worker broadcast arrives. itc.ts and serverHandlers.ts
// have a static-graph cycle (serverHandlers re-imports sendItcEvent from
// here), so we resolve it through a dynamic import that suspends the loader
// task until both modules' top-level bodies have completed.
const serverItcHandlersReady = import('../itc/serverHandlers.ts').then((m: any) => {
	// Dynamic import returns the namespace { default: handlersObj }. In CJS-dist
	// it may also be double-wrapped as { default: { default: handlersObj } }, so
	// pick the deepest non-namespace shape.
	serverItcHandlers = m.default?.default ?? m.default ?? m;
});
// Register the ack listener at module load (not via setImmediate) so the very
// first worker broadcast — which may land before any event-loop yield in main
// — sees a registered listener. The handler awaits serverItcHandlersReady
// before dispatching, but the ack itself is sent in the same async function
// body so it fires as soon as the import settles, not after handler work.
onMessageFromWorkers(async (event, sender) => {
	if (!serverItcHandlers) await serverItcHandlersReady;
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
