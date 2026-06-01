'use strict';

/* global threads */
const hdbLogger = require('../../utility/logging/harper_logger.ts');
const hdbTerms = require('../../utility/hdbTerms.ts');
const cleanLmdbMap =
	require('../../utility/lmdb/cleanLMDBMap.ts').default || require('../../utility/lmdb/cleanLMDBMap.ts');
const userSchema = require('../../security/user.ts');
const { validateEvent } = require('../threads/itc.js');
const harperBridge =
	require('../../dataLayer/harperBridge/harperBridge.ts').default ||
	require('../../dataLayer/harperBridge/harperBridge.ts');
const process = require('process');
const { resetDatabases } = require('../../resources/databases.ts');

/**
 * This object/functions are passed to the ITC client instance and dynamically added as event handlers.
 * @type {{schema: ((function(*): Promise<void>)|*), job: ((function(*): Promise<void>)|*), user: ((function(): Promise<void>)|*)}}
 */
const serverItcHandlers = {
	[hdbTerms.ITC_EVENT_TYPES.SCHEMA]: schemaHandler,
	[hdbTerms.ITC_EVENT_TYPES.USER]: userHandler,
	[hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST]: componentStatusRequestHandler,
	[hdbTerms.ITC_EVENT_TYPES.RESOURCE_OPENAPI_REQUEST]: resourceOpenApiRequestHandler,
};

/**
 * Updates the global hdbSchema object.
 * @param event
 * @returns {Promise<void>}
 */
const schemaListeners = [];
async function schemaHandler(event) {
	const validate = validateEvent(event);
	if (validate) {
		hdbLogger.error(validate);
		return;
	}

	hdbLogger.trace(`ITC schemaHandler received schema event:`, event);
	await cleanLmdbMap(event.message);
	await syncSchemaMetadata(event.message);
	for (let listener of schemaListeners) {
		try {
			listener(event?.message);
		} catch (err) {
			hdbLogger.error(err);
		}
	}
}

schemaHandler.addListener = function (listener) {
	schemaListeners.push(listener);
};

/**
 * Switch statement to handle schema-related messages from other forked processes - i.e. if another process completes an
 * operation that updates schema and, therefore, requires that we update the global schema value for the process
 *
 * @param msg
 * @returns {Promise<void>}
 */
async function syncSchemaMetadata(msg) {
	try {
		// TODO: Eventually should indicate which database/table changed so we don't have to scan everything
		let databases = resetDatabases();
		if (msg.table && msg.database)
			// wait for a write to finish to ensure all writes have been written
			await databases[msg.database][msg.table].put(Symbol.for('write-verify'), null);
	} catch (e) {
		hdbLogger.error(e);
	}
}

const userListeners = [];
/**
 * Updates the global hdbUsers object by querying the hdbRole table.
 * @param event
 * @returns {Promise<void>}
 */
async function userHandler(event) {
	try {
		try {
			harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME);
			harperBridge.resetReadTxn(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME);
		} catch (error) {
			// this can happen during tests, best to ignore
			hdbLogger.warn(error);
		}
		const validate = validateEvent(event);
		if (validate) {
			hdbLogger.error(validate);
			return;
		}

		hdbLogger.trace(`ITC userHandler ${hdbTerms.HDB_ITC_CLIENT_PREFIX}${process.pid} received user event:`, event);
		await userSchema.setUsersWithRolesCache();
		for (let listener of userListeners) listener();
	} catch (err) {
		hdbLogger.error(err);
	}
}

userHandler.addListener = function (listener) {
	userListeners.push(listener);
};

/**
 * Handles incoming requests for component status from inter-thread communication (ITC).
 * Validates the event, retrieves the current thread's component statuses, and sends a response
 * back to the originator thread with the requested information.
 *
 * @async
 * @function componentStatusRequestHandler
 * @param {Object} event - The event object containing the request details.
 * @param {Object} event.message - The message object within the event.
 * @param {string} event.message.originator - The identifier of the thread that originated the request.
 * @param {string} event.message.requestId - The unique identifier for the request.
 * @returns {Promise<void>} Sends a response back to the originator thread or logs an error if validation fails.
 */
async function componentStatusRequestHandler(event) {
	try {
		const validate = validateEvent(event);
		if (validate) {
			hdbLogger.error(validate);
			return;
		}

		hdbLogger.trace(`ITC componentStatusRequestHandler received request:`, event);

		// Get current thread's component status
		const { internal } = require('../../components/status/index.ts');
		const { getWorkerIndex } = require('../threads/manageThreads.js');
		const componentStatuses = internal.componentStatusRegistry.getAllStatuses();

		// Convert Map to array for serialization
		const statusArray = Array.from(componentStatuses.entries());

		// Get worker index and determine if this is the main thread
		const workerIndex = getWorkerIndex();
		const isMainThread = workerIndex === undefined;

		// Send response directly back to the originating thread. validateEvent already
		// ensures originator is present.
		const originatorThreadId = event.message.originator;
		const responseMessage = {
			type: hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_RESPONSE,
			message: {
				requestId: event.message.requestId,
				statuses: statusArray,
				workerIndex: workerIndex,
				isMainThread: isMainThread,
			},
		};

		if (threads.sendToThread(originatorThreadId, responseMessage)) {
			hdbLogger.trace(`Sent component status response directly to thread ${originatorThreadId}`);
		} else {
			// Originator's port is no longer in connectedPorts (thread exited / disconnected
			// during the request). Dropping the response is correct — the originator is
			// unreachable, and the collector's own timeout will handle the missing reply.
			hdbLogger.trace(
				`Dropping component status response for request ${event.message.requestId}: originator thread ${originatorThreadId} is unreachable`
			);
		}
	} catch (error) {
		hdbLogger.error('Error handling component status request:', error);
	}
}

/**
 * Handles incoming requests for the REST OpenAPI spec from the main thread.
 * Generates the spec from the local resources (which are only registered on worker threads)
 * and sends it back to the requesting thread.
 */
async function resourceOpenApiRequestHandler(event) {
	try {
		const validate = validateEvent(event);
		if (validate) {
			hdbLogger.error(validate);
			return;
		}

		hdbLogger.trace(`ITC resourceOpenApiRequestHandler received request:`, event);

		const { resources } = require('../../resources/Resources.ts');
		// Only respond if this thread has registered resources. Job-type workers with an empty
		// resources map must stay silent so that an app worker with real resources replies first.
		// If no worker has resources the main thread gets a 503 after the timeout, which is a
		// more honest response than silently returning an empty spec.
		if (!resources || resources.size === 0) return;
		const { generateJsonApi } = require('../../resources/openApi.ts');
		const openapi = generateJsonApi(resources, event.message.serverHttpURL);

		const originatorThreadId = event.message.originator;
		const responseMessage = {
			type: hdbTerms.ITC_EVENT_TYPES.RESOURCE_OPENAPI_RESPONSE,
			message: {
				requestId: event.message.requestId,
				openapi,
			},
		};

		if (!threads.sendToThread(originatorThreadId, responseMessage)) {
			hdbLogger.trace(
				`Dropping resource OpenAPI response for request ${event.message.requestId}: originator thread ${originatorThreadId} is unreachable`
			);
		}
	} catch (error) {
		hdbLogger.error('Error handling resource OpenAPI request:', error);
	}
}

module.exports = serverItcHandlers;
// Named exports so consumers (e.g., MCP listChanged) can subscribe via
// `userHandler.addListener(fn)` / `schemaHandler.addListener(fn)`.
module.exports.userHandler = userHandler;
module.exports.schemaHandler = schemaHandler;
