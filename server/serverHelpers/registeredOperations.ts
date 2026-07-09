/**
 * Cross-thread bridge for `server.registerOperation()` (#1736).
 *
 * Components (jsResource `resources.js`, Plugin API `handleApplication`) load per-worker, so a
 * `registerOperation()` call made there lands in that worker's module-local OPERATION_FUNCTION_MAP.
 * The ops-API HTTP dispatcher runs only on the main thread and reads the main thread's copy of
 * that map, so such operations were unreachable ("Operation '<name>' not found") for every caller.
 *
 * The bridge mirrors the RESOURCE_OPENAPI request/response pattern (operationsServer.ts /
 * itc/serverHandlers.js), with one deliberate difference: executing an operation is side-effecting,
 * so a request is sent to exactly ONE registering worker (never broadcast-first-wins).
 *
 *  - Worker: `registerOperation()` announces the name (OPERATION_REGISTERED) to all threads;
 *    only the main thread records it, as name -> Set<threadId>.
 *  - Main: on an OPERATION_FUNCTION_MAP miss, `getRemoteOperationFunction()` supplies a forwarding
 *    function that sends the request body (OPERATION_EXECUTE_REQUEST) to one live registering
 *    worker and awaits the correlated OPERATION_EXECUTE_RESPONSE.
 *  - Worker: executes through the normal `chooseOperation` + `processLocalTransaction` path, so
 *    permission checks run where the operation function (and its metadata) actually exists. The
 *    main thread performs authentication only and forwards the resolved `hdb_user`.
 */
import { isMainThread, threadId } from 'node:worker_threads';
import { Readable } from 'node:stream';
import * as terms from '../../utility/hdbTerms.ts';
import * as env from '../../utility/environment/environmentManager.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import { sendItcEvent } from '../threads/itc.js';
import { onMessageByType, onThreadExit } from '../threads/manageThreads.js';

const operationLog = harperLogger.loggerWithTag('operation');

// The connected-ports array with `sendToThread` — assigned to the `threads` global by
// manageThreads via _assignPackageExport (the same access pattern as itc/serverHandlers.js;
// the globals.js `exports.threads` binding is reassigned after load, so it can't be imported).
declare const threads: { sendToThread(threadId: number, message: any): boolean };

// Fields attached to a request body by the HTTP/auth layer that must not (and often cannot)
// cross the thread boundary via structured clone.
const NON_FORWARDABLE_FIELDS = ['baseRequest', 'baseResponse', 'fastifyResponse', 'progress', 'parsed_sql_object'];

// Bound how long the main thread waits for a worker to finish a forwarded operation. Past the
// operations-API connection timeout the client socket is gone anyway; this just prevents a
// wedged-but-alive worker from leaking pending forwards forever.
const EXECUTE_TIMEOUT_MS = env.get(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_TIMEOUT) || 120_000;

// Dispatch functions injected by serverUtilities at its module load (it statically imports this
// module, so a plain import here would be a cycle; a runtime require of a .ts path doesn't
// survive the dist build). A worker can only receive an execute request after announcing a
// registration — which goes through serverUtilities — so these are always set on that path.
let localDispatch: {
	chooseOperation: (body: any) => Function;
	processLocalTransaction: (req: any, operationFunction: Function) => Promise<any>;
};
export function setLocalOperationDispatch(dispatch: typeof localDispatch) {
	localDispatch = dispatch;
}

/** name -> threadIds of workers that registered it (main thread only) */
const registeredByWorker = new Map<string, Set<number>>();
const pendingExecutions = new Map<
	number,
	{ targetThreadId: number; resolve: (result: any) => void; reject: (error: Error) => void }
>();
let nextRequestId = 1;
let mainListenersAttached = false;

/**
 * Worker side: announce a registration so the main thread can forward calls here. Fire-and-forget —
 * a lost announcement just means the op stays unreachable (the pre-#1736 status quo), and the
 * broadcast has its own ack timeout.
 */
export function announceRegisteredOperation(name: string) {
	if (isMainThread) return;
	sendItcEvent({
		type: terms.ITC_EVENT_TYPES.OPERATION_REGISTERED,
		message: { name },
	}).catch((error) => operationLog.error(`Failed to announce registered operation '${name}'`, error));
}

/**
 * ITC handler (all threads receive the broadcast; only main records it).
 */
export function operationRegisteredHandler(event: { message: { name: string; originator: number } }) {
	if (!isMainThread) return;
	const { name, originator } = event.message;
	if (typeof name !== 'string' || typeof originator !== 'number') return;
	let workerIds = registeredByWorker.get(name);
	if (!workerIds) registeredByWorker.set(name, (workerIds = new Set()));
	workerIds.add(originator);
	operationLog.debug(`Registered operation '${name}' announced by worker thread ${originator}`);
}

let rotation = 0;
/**
 * Main-thread dispatch fallback: if a worker registered `name`, return a forwarding operation
 * function for it; otherwise undefined (caller falls through to the usual "not found" error).
 * Permission checks are intentionally NOT run on the main thread for forwarded operations — the
 * function and metadata that `verifyPerms` needs only exist on the worker, which runs the full
 * `chooseOperation` check with the forwarded `hdb_user`.
 */
export function getRemoteOperationFunction(name: string): ((body: any) => Promise<any>) | undefined {
	if (!isMainThread) return undefined;
	if (!registeredByWorker.has(name)) return undefined;
	return (body: any) => executeRemoteOperation(name, body);
}

function attachMainListeners() {
	if (mainListenersAttached) return;
	mainListenersAttached = true;
	onMessageByType(terms.ITC_EVENT_TYPES.OPERATION_EXECUTE_RESPONSE, (event: any) => {
		const { requestId, originator, result, error } = event.message ?? {};
		const pending = pendingExecutions.get(requestId);
		if (!pending) return;
		// Defense-in-depth: only the worker the request was sent to may settle it.
		if (originator !== pending.targetThreadId) return;
		pendingExecutions.delete(requestId);
		if (error) pending.reject(new ServerError(error.message, error.statusCode || 500));
		else pending.resolve(result);
	});
	// A worker that dies mid-execution can never respond; fail its in-flight forwards rather
	// than waiting out the timeout, and forget its registrations (a replacement worker
	// re-registers on component load).
	onThreadExit((deadThreadId: number) => {
		for (const [name, workerIds] of registeredByWorker) {
			workerIds.delete(deadThreadId);
			if (workerIds.size === 0) registeredByWorker.delete(name);
		}
		for (const [requestId, pending] of pendingExecutions) {
			if (pending.targetThreadId === deadThreadId) {
				pendingExecutions.delete(requestId);
				pending.reject(new ServerError('The worker thread executing this operation exited', 503));
			}
		}
	});
}

function executeRemoteOperation(name: string, body: any): Promise<any> {
	attachMainListeners();
	const workerIds = registeredByWorker.get(name);
	const forwardBody = { ...body };
	for (const field of NON_FORWARDABLE_FIELDS) delete forwardBody[field];

	// Pick one live registering worker (rotating for spread), pruning ids whose port is gone.
	// sendToThread returning false means the worker exited; try the next one.
	while (workerIds?.size) {
		const candidates = [...workerIds];
		const targetThreadId = candidates[rotation++ % candidates.length];
		const requestId = nextRequestId++;
		let sent;
		try {
			sent = threads.sendToThread(targetThreadId, {
				type: terms.ITC_EVENT_TYPES.OPERATION_EXECUTE_REQUEST,
				message: { requestId, body: forwardBody, originator: threadId },
			});
		} catch (error) {
			// Structured-clone failure (e.g. a function or native handle on the request body) —
			// no other worker will fare better with the same body.
			operationLog.error(`Failed to forward operation '${name}' to worker thread ${targetThreadId}`, error);
			return Promise.reject(
				new ServerError(`Operation '${name}' request could not be forwarded to a worker thread: ${error.message}`, 400)
			);
		}
		if (!sent) {
			workerIds.delete(targetThreadId);
			continue;
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingExecutions.delete(requestId);
				reject(new ServerError(`Timed out waiting for worker thread to execute operation '${name}'`, 503));
			}, EXECUTE_TIMEOUT_MS);
			timer.unref?.();
			pendingExecutions.set(requestId, {
				targetThreadId,
				resolve(result) {
					clearTimeout(timer);
					resolve(result);
				},
				reject(error) {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}
	if (registeredByWorker.get(name)?.size === 0) registeredByWorker.delete(name);
	return Promise.reject(
		new ServerError(`Operation '${name}' is registered by a component but no worker thread is available to run it`, 503)
	);
}

/**
 * ITC handler, worker side: execute a forwarded operation through the normal dispatch path
 * (permission check + processLocalTransaction) and send the result back to the main thread.
 */
export async function operationExecuteRequestHandler(event: {
	message: { requestId: number; body: any; originator: number };
}) {
	const { requestId, body, originator } = event.message;
	let response;
	try {
		if (!localDispatch) throw new ServerError('This worker thread cannot execute operations', 503);
		// The main thread already stripped bypass_auth from external requests; re-assert here so a
		// forged ITC-level message can't skip the worker-side permission check.
		delete body.bypass_auth;
		const operationFunction = localDispatch.chooseOperation(body);
		const result = await localDispatch.processLocalTransaction({ body }, operationFunction);
		if (result instanceof Readable || typeof result?.pipe === 'function') {
			// Streaming results would need MessagePort transfer plumbing — explicitly unsupported
			// for worker-registered operations for now (#1736), rather than failing opaquely.
			throw new ServerError(
				`Operation '${body.operation}' returned a stream; streaming results are not supported for operations registered from a component`,
				501
			);
		}
		response = { requestId, result };
	} catch (error) {
		response = {
			requestId,
			error: {
				message: error.http_resp_msg?.error ?? error.http_resp_msg ?? error.message,
				statusCode: error.statusCode,
			},
		};
	}
	try {
		sendExecuteResponse(originator, response);
	} catch (error) {
		// The result itself failed to structured-clone; report that instead of leaving the main
		// thread to time out.
		operationLog.error(`Failed to send result of operation '${body?.operation}' back to the main thread`, error);
		sendExecuteResponse(originator, {
			requestId,
			error: {
				message: `Operation '${body?.operation}' result could not be returned across threads: ${error.message}`,
				statusCode: 500,
			},
		});
	}
}

function sendExecuteResponse(requestOriginator: number, message: any) {
	// Stamp this worker's threadId so the main thread can verify the response came from the
	// worker the request was actually sent to.
	message.originator = threadId;
	if (!threads.sendToThread(requestOriginator, { type: terms.ITC_EVENT_TYPES.OPERATION_EXECUTE_RESPONSE, message })) {
		operationLog.trace(`Dropping operation execute response for request ${message.requestId}: main thread unreachable`);
	}
}
