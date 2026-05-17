'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
import { sendItcEvent } from '../server/threads/itc.ts';
import { onStartup } from './lifecycle.ts';

let serverItcHandlers;
// Preload server-itc-handlers during the startup phase so signalSchemaChange
// and signalUserChange can stay synchronous (their callers and tests assume so).
onStartup(async () => {
	const mod: any = await import('../server/itc/serverHandlers.ts');
	// CJS dist double-wraps default: namespace.default is `exports`, exports.default is the real value.
	serverItcHandlers = mod.default?.default ?? mod.default ?? mod;
});

function ensureServerItcHandlers() {
	// In production the `onStartup` hook above preloads this. In unit tests
	// where startup never runs, downstream consumers may call us synchronously;
	// if `serverItcHandlers` is still undefined the optional-chained access in
	// the caller no-ops, matching the original lazy `require` semantics where
	// a failed load was caught and logged.
	return serverItcHandlers;
}

// Await BOTH the local handler and the cross-worker broadcast. The local handler is what
// rebuilds THIS thread's cache; firing it un-awaited let the originating worker return success
// before its own cache caught up, so the next request it served observed stale state even though
// the op awaited propagation to the other workers — the originator half of #1497. Both legs
// resolve without rejecting (each handler has its own try/catch; the broadcast always resolves),
// so Promise.all is safe here. Callers that don't await keep their prior fire-and-forget behavior.
export function signalSchemaChange(message: any) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		ensureServerItcHandlers();
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		return Promise.all([serverItcHandlers?.schema(itcEventSchema), sendItcEvent(itcEventSchema)]);
	} catch (err) {
		hdbLogger.error(err);
	}
}

/**
 * Notify local listeners that JS resources have just been registered (resources.js loaded). This is
 * deliberately local-only — no ITC broadcast — because every worker registers its own JS resources,
 * so the dependent rebuild (MCP application tools) belongs in the worker where the registration
 * happened. See `resourceHandler` in server/itc/serverHandlers.js and issue #1448.
 */
export function signalResourcesRegistered() {
	try {
		ensureServerItcHandlers();
		serverItcHandlers?.resourceHandler();
	} catch (err) {
		hdbLogger.error(err);
	}
}

export function signalUserChange(message: any) {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		ensureServerItcHandlers();
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		return Promise.all([serverItcHandlers?.user(itcEventUser), sendItcEvent(itcEventUser)]);
	} catch (err) {
		hdbLogger.error(err);
	}
}
