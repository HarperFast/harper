'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
import { isMainThread } from 'node:worker_threads';
let serverItcHandlers;
import { sendItcEvent } from '../server/threads/itc.js';

export const PREPARE_DATABASE_DROP_OPERATION = 'prepare-database-drop';
export const CANCEL_DATABASE_DROP_OPERATION = 'cancel-database-drop';

// Await BOTH the local handler and the cross-worker broadcast. The local handler is what
// rebuilds THIS thread's cache; firing it un-awaited let the originating worker return success
// before its own cache caught up, so the next request it served observed stale state even though
// the op awaited propagation to the other workers — the originator half of #1497. Promise.all also
// lets a strict handler or broadcast failure reach this function's logging boundary. Callers that
// don't await keep their prior fire-and-forget behavior.
type SchemaSignalOptions = {
	excludeThreadId?: number;
	includeJobWorkers?: boolean;
	mainFirst?: boolean;
	onlyThreadId?: number;
	rejectOnError?: boolean;
};

export async function signalSchemaChange(message: any, options?: SchemaSignalOptions) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		if (options?.mainFirst) {
			let localError;
			let localFailed = false;
			try {
				await serverItcHandlers.schema(itcEventSchema);
			} catch (error) {
				localFailed = true;
				localError = error ?? new Error('Local schema-change handler rejected without an error');
			}
			try {
				await signalSchemaChangeToPeers(message, options);
			} catch (peerError) {
				if (localFailed)
					throw new AggregateError([localError, peerError], 'Local and peer schema-change handling failed');
				throw peerError;
			}
			if (localFailed) throw localError;
		} else {
			await Promise.all([serverItcHandlers.schema(itcEventSchema), sendItcEvent(itcEventSchema, options)]);
		}
	} catch (err) {
		hdbLogger.error(err);
		if (options?.rejectOnError) throw err;
	}
}

export async function signalSchemaChangeToPeers(message: any, options?: SchemaSignalOptions) {
	if (options?.mainFirst && !isMainThread) {
		const mainEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, { ...message });
		await sendItcEvent(mainEvent, { ...options, onlyThreadId: 0 });
		const peerEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, { ...message });
		await sendItcEvent(peerEvent, { ...options, excludeThreadId: 0 });
		return;
	}
	const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
	await sendItcEvent(itcEventSchema, options);
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
