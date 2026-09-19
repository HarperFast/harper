'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
import { isMainThread, threadId } from 'node:worker_threads';
import { DATABASE_QUIESCENCE_TIMEOUT_MS } from './databaseLifecycle.ts';
let serverItcHandlers;
import { sendItcEvent } from '../server/threads/itc.js';

export const PREPARE_DATABASE_DROP_OPERATION = 'prepare-database-drop';
export const CANCEL_DATABASE_DROP_OPERATION = 'cancel-database-drop';
export const DATABASE_DROP_ACKNOWLEDGEMENT_TIMEOUT_MS = DATABASE_QUIESCENCE_TIMEOUT_MS;

// Await both local handling and peer propagation so the caller cannot outrun its own schema cache.
type SchemaSignalOptions = {
	acceptWorkerDatabaseClose?: boolean;
	excludeThreadId?: number;
	includeJobWorkers?: boolean;
	mainFirst?: boolean;
	onlyThreadId?: number;
	rejectOnError?: boolean;
	relayFromMain?: boolean;
	acknowledgementTimeoutMs?: number;
};

export function databaseDropSignalOptions(acceptWorkerDatabaseClose: boolean): SchemaSignalOptions {
	return {
		acceptWorkerDatabaseClose,
		acknowledgementTimeoutMs: DATABASE_DROP_ACKNOWLEDGEMENT_TIMEOUT_MS,
		includeJobWorkers: true,
		mainFirst: true,
		rejectOnError: true,
	};
}

export function aggregateSchemaChangeErrors(errors: unknown[], message: string): AggregateError {
	const failure: any = new AggregateError(errors, message);
	const statusCode = (errors[0] as any)?.statusCode;
	if (statusCode !== undefined && errors.every((error) => (error as any)?.statusCode === statusCode))
		failure.statusCode = statusCode;
	return failure;
}

export async function signalSchemaChange(message: any, options?: SchemaSignalOptions) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		if (options?.relayFromMain) {
			message.originator = threadId;
			message.relaySchemaChangeFromMain = true;
		}
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		if (options?.relayFromMain) {
			if (isMainThread) await serverItcHandlers.schema(itcEventSchema);
			else await sendItcEvent(itcEventSchema, { ...options, onlyThreadId: 0 });
			return;
		}
		if (options?.mainFirst) {
			let localError;
			let localFailed = false;
			try {
				await serverItcHandlers.schema(itcEventSchema);
			} catch (error) {
				localFailed = true;
				localError = error ?? new Error('Local schema-change handler rejected without an error');
			}
			if (localFailed && message.operation === PREPARE_DATABASE_DROP_OPERATION) throw localError;
			try {
				await signalSchemaChangeToPeers(message, options);
			} catch (peerError) {
				if (localFailed)
					throw aggregateSchemaChangeErrors([localError, peerError], 'Local and peer schema-change handling failed');
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
		let mainError;
		try {
			await sendItcEvent(mainEvent, { ...options, onlyThreadId: 0 });
		} catch (error) {
			mainError = error ?? new Error('Main-thread schema-change handler rejected without an error');
		}
		if (mainError && message.operation === PREPARE_DATABASE_DROP_OPERATION) throw mainError;
		const peerEvent = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, { ...message });
		try {
			await sendItcEvent(peerEvent, { ...options, excludeThreadId: 0 });
		} catch (peerError) {
			if (mainError)
				throw aggregateSchemaChangeErrors([mainError, peerError], 'Main and peer schema-change handling failed');
			throw peerError;
		}
		if (mainError) throw mainError;
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
