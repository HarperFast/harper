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
const { isMainThread, workerData } = require('worker_threads');
const {
	resetDatabases,
	closeDatabase,
	quiesceSchemaTarget,
	abortSchemaQuiesce,
	commitSchemaQuiesce,
	renewSchemaQuiesce,
	finishSchemaQuiesce,
	completeSchemaQuiesce,
	failSchemaQuiesceFinalization,
} = require('../../resources/databases.ts');
const { holdWorkerStartsForSchema, releaseWorkerStartsForSchema } = require('../threads/manageThreads.js');

/**
 * This object/functions are passed to the ITC client instance and dynamically added as event handlers.
 * @type {{schema: ((function(*): Promise<void>)|*), job: ((function(*): Promise<void>)|*), user: ((function(): Promise<void>)|*)}}
 */
const serverItcHandlers = {
	[hdbTerms.ITC_EVENT_TYPES.SCHEMA]: schemaHandler,
	[hdbTerms.ITC_EVENT_TYPES.USER]: userHandler,
	[hdbTerms.ITC_EVENT_TYPES.COMPONENT_STATUS_REQUEST]: componentStatusRequestHandler,
	[hdbTerms.ITC_EVENT_TYPES.RESOURCE_OPENAPI_REQUEST]: resourceOpenApiRequestHandler,
	[hdbTerms.ITC_EVENT_TYPES.MIDDLEWARE_CHAINS_REQUEST]: middlewareChainsRequestHandler,
	// #1736 cross-thread registered-operation bridge. Lazy require: this module loads on every
	// thread via itc.js, and registeredOperations pulls in the serverUtilities module graph.
	[hdbTerms.ITC_EVENT_TYPES.OPERATION_REGISTERED]: (event) =>
		require('../serverHelpers/registeredOperations.ts').operationRegisteredHandler(event),
	[hdbTerms.ITC_EVENT_TYPES.OPERATION_EXECUTE_REQUEST]: (event) =>
		require('../serverHelpers/registeredOperations.ts').operationExecuteRequestHandler(event),
};

/**
 * Updates the global hdbSchema object.
 * @param event
 * @returns {Promise<void>}
 */
const schemaListeners = [];
const MAX_SCHEMA_TERMINAL_OUTCOMES = 1024;
const schemaTerminalCompletions = new Map();
const schemaTerminalOutcomes = new Map();
const schemaWorkerBarrierLeases = new Map();

function armSchemaWorkerBarrierLease(message) {
	if (!isMainThread) return;
	const existing = schemaWorkerBarrierLeases.get(message.quiesceId);
	if (existing) clearTimeout(existing);
	const delay = Math.max(0, (message.leaseUntil ?? Date.now()) - Date.now());
	const timer = setTimeout(() => {
		schemaWorkerBarrierLeases.delete(message.quiesceId);
		releaseWorkerStartsForSchema(message.quiesceId);
	}, delay);
	timer.unref();
	schemaWorkerBarrierLeases.set(message.quiesceId, timer);
}

function commitSchemaWorkerBarrier(message) {
	if (!isMainThread) return;
	const timer = schemaWorkerBarrierLeases.get(message.quiesceId);
	if (timer) clearTimeout(timer);
	schemaWorkerBarrierLeases.delete(message.quiesceId);
}

function releaseSchemaWorkerBarrier(message) {
	if (!isMainThread) return;
	commitSchemaWorkerBarrier(message);
	releaseWorkerStartsForSchema(message.quiesceId);
}

function sameSchemaTerminalRequest(entry, message) {
	return (
		entry.phase === message.phase &&
		entry.operation === message.operation &&
		entry.schema === message.schema &&
		entry.table === message.table
	);
}

function schemaTerminalEntry(message, value) {
	return {
		phase: message.phase,
		operation: message.operation,
		schema: message.schema,
		table: message.table,
		value,
	};
}

function retainSchemaTerminalOutcome(message, result) {
	schemaTerminalOutcomes.set(message.quiesceId, schemaTerminalEntry(message, result));
	while (schemaTerminalOutcomes.size > MAX_SCHEMA_TERMINAL_OUTCOMES) {
		const oldestId = schemaTerminalOutcomes.keys().next().value;
		schemaTerminalOutcomes.delete(oldestId);
	}
}

async function schemaHandler(event) {
	const validate = validateEvent(event);
	if (validate) {
		hdbLogger.error(validate);
		return;
	}

	hdbLogger.trace(`ITC schemaHandler received schema event:`, event);
	if (event.message?.phase === 'hold-worker-starts') {
		holdWorkerStartsForSchema(event.message.quiesceId);
		armSchemaWorkerBarrierLease(event.message);
		return { held: true };
	}
	if (event.message?.phase === 'release-worker-starts') {
		releaseSchemaWorkerBarrier(event.message);
		return { released: true };
	}
	if (event.message?.phase === 'quiesce') return quiesceSchemaTarget(event.message);
	if (event.message?.phase === 'renew-quiesce') {
		const result = renewSchemaQuiesce(event.message);
		if (result.quiesced) armSchemaWorkerBarrierLease(event.message);
		return result;
	}
	if (event.message?.phase === 'commit-quiesce') {
		const result = await commitSchemaQuiesce(event.message);
		if (result.committed) commitSchemaWorkerBarrier(event.message);
		return result;
	}
	if (event.message?.phase === 'abort-quiesce') {
		await abortSchemaQuiesce(event.message);
		return { aborted: true };
	}
	const terminalPhase =
		event.message?.phase === 'finalize-quiesce'
			? 'finalized'
			: event.message?.phase === 'reconcile-quiesce'
				? 'reconciled'
				: undefined;
	if (terminalPhase) {
		const quiesceId = event.message.quiesceId;
		const outcome = schemaTerminalOutcomes.get(quiesceId);
		if (outcome) return sameSchemaTerminalRequest(outcome, event.message) ? outcome.value : { [terminalPhase]: false };
		const active = schemaTerminalCompletions.get(quiesceId);
		if (active) return sameSchemaTerminalRequest(active, event.message) ? active.value : { [terminalPhase]: false };
		const completion = applySchemaChange(event, terminalPhase);
		schemaTerminalCompletions.set(quiesceId, schemaTerminalEntry(event.message, completion));
		try {
			const result = await completion;
			if (result?.[terminalPhase] === true) retainSchemaTerminalOutcome(event.message, result);
			return result;
		} finally {
			if (schemaTerminalCompletions.get(quiesceId)?.value === completion) schemaTerminalCompletions.delete(quiesceId);
		}
	}
	return applySchemaChange(event);
}

async function applySchemaChange(event, terminalPhase) {
	if (terminalPhase && !finishSchemaQuiesce(event.message)) return { [terminalPhase]: false };
	try {
		// restore_backup: this thread must release its store handles so the restore can purge and
		// rewrite the database directory. The rescan below (resetDatabases) skips reloading it while
		// the restoring marker is present, and reloads it on the completion signal (marker gone).
		if (event.message?.operation === hdbTerms.OPERATIONS_ENUM.RESTORE_BACKUP && event.message.schema) {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					await closeDatabase(event.message.schema);
					break;
				} catch (error) {
					hdbLogger.warn(
						`Could not close database ${event.message.schema} for restore${attempt === 0 ? '; retrying once' : ''}:`,
						error
					);
					if (attempt === 1) return;
				}
			}
		}
		await cleanLmdbMap(event.message);
		await syncSchemaMetadata(event.message, Boolean(terminalPhase));
		for (let listener of schemaListeners) {
			try {
				listener(event?.message);
			} catch (err) {
				hdbLogger.error(err);
			}
		}
		if (terminalPhase) {
			completeSchemaQuiesce(event.message);
			return { [terminalPhase]: true };
		}
	} catch (error) {
		if (terminalPhase) failSchemaQuiesceFinalization(event.message);
		throw error;
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
async function syncSchemaMetadata(msg, strict = false) {
	try {
		// TODO: Eventually should indicate which database/table changed so we don't have to scan everything
		let databases = resetDatabases();
		if (msg.table && msg.database)
			// wait for a write to finish to ensure all writes have been written
			await databases[msg.database][msg.table].put(Symbol.for('write-verify'), null);
	} catch (e) {
		if (strict) throw e;
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

const resourceListeners = [];
/**
 * Local-only fan-out for "JS resources just registered" (resources.js loaded via the jsResource
 * plugin). Unlike schema/user changes this is NOT an ITC event: each worker loads and registers
 * its own JS resources, so a listener (e.g. the MCP application-tool rebuild) only needs to run in
 * the worker where the registration happened. Surfaces author opt-ins (`static mcpTools`/
 * `mcpPrompts`) that land on the resource registry after the MCP component's boot scan (#1448).
 */
function resourceHandler() {
	for (const listener of resourceListeners) {
		try {
			listener();
		} catch (err) {
			hdbLogger.error(err);
		}
	}
}
resourceHandler.addListener = function (listener) {
	resourceListeners.push(listener);
};
// Test seam: drop registered listeners so a unit suite doesn't leak fakes into later suites.
resourceHandler._resetListenersForTest = function () {
	resourceListeners.length = 0;
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

/**
 * Handles the main thread's request for the resolved HTTP/upgrade/WebSocket middleware chains (#1573).
 * Only HTTP workers reply: the main thread carries just the operations-API middleware (so it stays
 * silent even though it has responders), and job workers have none. HTTP workers answer even when
 * they have no middleware (empty chains) so get_status doesn't wait out the request timeout. First
 * worker to answer wins — all HTTP workers register identically, so any one is representative.
 */
async function middlewareChainsRequestHandler(event) {
	try {
		const validate = validateEvent(event);
		if (validate) {
			hdbLogger.error(validate);
			return;
		}

		if (isMainThread || workerData?.name !== hdbTerms.THREAD_TYPES.HTTP) return;
		const { describeMiddlewareChains } = require('../http.ts');

		const responseMessage = {
			type: hdbTerms.ITC_EVENT_TYPES.MIDDLEWARE_CHAINS_RESPONSE,
			message: {
				requestId: event.message.requestId,
				chains: describeMiddlewareChains(),
			},
		};

		if (!threads.sendToThread(event.message.originator, responseMessage)) {
			hdbLogger.trace(
				`Dropping middleware chains response for request ${event.message.requestId}: originator thread ${event.message.originator} is unreachable`
			);
		}
	} catch (error) {
		hdbLogger.error('Error handling middleware chains request:', error);
	}
}

module.exports = serverItcHandlers;
// Named exports so consumers (e.g., MCP listChanged) can subscribe via
// `userHandler.addListener(fn)` / `schemaHandler.addListener(fn)`.
module.exports.userHandler = userHandler;
module.exports.schemaHandler = schemaHandler;
module.exports.resourceHandler = resourceHandler;
