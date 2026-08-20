'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
let serverItcHandlers;
import { sendItcEvent } from '../server/threads/itc.js';

// Await BOTH the local handler and the cross-worker broadcast. The local handler is what
// rebuilds THIS thread's cache; firing it un-awaited let the originating worker return success
// before its own cache caught up, so the next request it served observed stale state even though
// the op awaited propagation to the other workers — the originator half of #1497. Both legs
// resolve without rejecting (each handler has its own try/catch; the broadcast always resolves),
// so Promise.all is safe here. Callers that don't await keep their prior fire-and-forget behavior.
export async function signalSchemaChange(message: any) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		await Promise.all([serverItcHandlers.schema(itcEventSchema), sendItcEvent(itcEventSchema)]);
	} catch (err) {
		hdbLogger.error(err);
	}
}

const SCHEMA_QUIESCE_TIMEOUT_MS = 30_000;
const SCHEMA_QUIESCE_LEASE_MS = 120_000;
const SCHEMA_QUIESCE_RENEW_MS = 40_000;
const SCHEMA_FINALIZE_ATTEMPTS = 3;
const schemaQuiesceRenewals = new Map<string, NodeJS.Timeout>();

function stopSchemaQuiesceRenewal(quiesceId: string) {
	const renewal = schemaQuiesceRenewals.get(quiesceId);
	if (renewal) clearInterval(renewal);
	schemaQuiesceRenewals.delete(quiesceId);
}

function startSchemaQuiesceRenewal(message: any) {
	stopSchemaQuiesceRenewal(message.quiesceId);
	const renewal = setInterval(() => {
		const renewalMessage = {
			...message,
			phase: 'renew-quiesce',
			leaseUntil: Date.now() + SCHEMA_QUIESCE_LEASE_MS,
		};
		const event = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, renewalMessage);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		Promise.all([
			serverItcHandlers.schema(event).then((result) => {
				if (result?.quiesced !== true) throw new Error(`Could not renew local schema quiesce ${message.quiesceId}`);
			}),
			sendItcEvent(event, {
				timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
				acceptResult: (result) => result?.quiesced === true,
				includeJobWorkers: true,
			}),
		]).catch((error) => hdbLogger.warn('Could not renew schema quiesce lease:', error));
	}, SCHEMA_QUIESCE_RENEW_MS);
	renewal.unref();
	schemaQuiesceRenewals.set(message.quiesceId, renewal);
}

export async function quiesceSchemaChange(message: any) {
	const quiesceMessage = {
		...message,
		originator: threadId,
		phase: 'quiesce',
		quiesceId: randomUUID(),
		leaseUntil: Date.now() + SCHEMA_QUIESCE_LEASE_MS,
	};
	try {
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const holdEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, {
			...quiesceMessage,
			phase: 'hold-worker-starts',
		});
		const localHold = await serverItcHandlers.schema(holdEvent);
		if (localHold?.held !== true) throw new Error(`Could not hold local worker starts for ${quiesceMessage.quiesceId}`);
		await sendItcEvent(holdEvent, {
			timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
			acceptResult: (result) => result?.held === true,
			includeJobWorkers: true,
		});
		const localEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, {
			...quiesceMessage,
			originLocal: true,
		});
		const localResult = await serverItcHandlers.schema(localEvent);
		if (localResult?.quiesced !== true)
			throw new Error(localResult?.reason ?? `Could not quiesce local schema target ${quiesceMessage.quiesceId}`);
		const event = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, quiesceMessage);
		await sendItcEvent(event, {
			timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
			acceptResult: (result) => result?.quiesced === true,
			includeJobWorkers: true,
		});
		startSchemaQuiesceRenewal(quiesceMessage);
		return quiesceMessage;
	} catch (error) {
		await abortSchemaQuiesce(quiesceMessage);
		throw error;
	}
}

export async function abortSchemaQuiesce(message: any) {
	stopSchemaQuiesceRenewal(message.quiesceId);
	try {
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const event = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, {
			...message,
			phase: 'abort-quiesce',
		});
		const localResult = await serverItcHandlers.schema(event);
		if (localResult?.aborted !== true) throw new Error(`Could not abort local schema quiesce ${message.quiesceId}`);
		await sendItcEvent(event, {
			timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
			acceptResult: (result) => result?.aborted === true,
			includeJobWorkers: true,
		});
	} catch (error) {
		hdbLogger.warn('Could not confirm schema quiesce abort on every worker:', error);
	} finally {
		await releaseSchemaWorkerBarrier(message);
	}
}

async function releaseSchemaWorkerBarrier(message: any) {
	serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
	const event = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, {
		...message,
		phase: 'release-worker-starts',
	});
	try {
		await serverItcHandlers.schema(event);
	} catch (error) {
		hdbLogger.warn('Could not release the local worker-start barrier:', error);
	}
	try {
		await sendItcEvent(event, {
			timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
			acceptResult: (result) => result?.released === true,
			includeJobWorkers: true,
		});
	} catch (error) {
		hdbLogger.warn('Could not confirm worker-start barrier release:', error);
	}
}

export async function commitSchemaChange(message: any) {
	serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
	const commitMessage = {
		...message,
		phase: 'commit-quiesce',
		leaseUntil: Date.now() + SCHEMA_QUIESCE_LEASE_MS,
	};
	const localEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, commitMessage);
	const localResult = await serverItcHandlers.schema(localEvent);
	if (localResult?.committed !== true)
		throw new Error(localResult?.reason ?? `Could not commit local schema quiesce ${message.quiesceId}`);
	let lastError: unknown;
	for (let attempt = 0; attempt < SCHEMA_FINALIZE_ATTEMPTS; attempt++) {
		try {
			const event = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, commitMessage);
			await sendItcEvent(event, {
				timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
				acceptResult: (result) => result?.committed === true,
				includeJobWorkers: true,
			});
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`Could not commit schema quiesce ${message.quiesceId} on every worker; remaining fail-closed`, {
		cause: lastError,
	});
}

async function completeSchemaChange(message: any, phase: string, resultProperty: string) {
	try {
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const finalMessage = { ...message, phase };
		const localEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, finalMessage);
		const localResult = await serverItcHandlers.schema(localEvent);
		if (localResult?.[resultProperty] !== true)
			throw new Error(`Could not ${resultProperty} local schema quiesce ${message.quiesceId}`);
		let lastError: unknown;
		for (let attempt = 0; attempt < SCHEMA_FINALIZE_ATTEMPTS; attempt++) {
			try {
				const event = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, finalMessage);
				await sendItcEvent(event, {
					timeout: SCHEMA_QUIESCE_TIMEOUT_MS,
					acceptResult: (result) => result?.[resultProperty] === true,
					includeJobWorkers: true,
				});
				return;
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error(`Could not ${resultProperty} schema quiesce ${message.quiesceId} on every worker`, {
			cause: lastError,
		});
	} finally {
		stopSchemaQuiesceRenewal(message.quiesceId);
		await releaseSchemaWorkerBarrier(message);
	}
}

export function finalizeSchemaChange(message: any) {
	return completeSchemaChange(message, 'finalize-quiesce', 'finalized');
}

export function reconcileSchemaChange(message: any) {
	return completeSchemaChange(message, 'reconcile-quiesce', 'reconciled');
}

/**
 * Notify local listeners that JS resources have just been registered (resources.js loaded). This is
 * deliberately local-only — no ITC broadcast — because every worker registers its own JS resources,
 * so the dependent rebuild (MCP application tools) belongs in the worker where the registration
 * happened. See `resourceHandler` in server/itc/serverHandlers.js and issue #1448.
 */
export function signalResourcesRegistered() {
	try {
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		serverItcHandlers.resourceHandler();
	} catch (err) {
		hdbLogger.error(err);
	}
}

export async function signalUserChange(message: any) {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		await Promise.all([serverItcHandlers.user(itcEventUser), sendItcEvent(itcEventUser)]);
	} catch (err) {
		hdbLogger.error(err);
	}
}
