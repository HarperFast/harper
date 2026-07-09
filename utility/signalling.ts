'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
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
		hdbLogger.error(hdbLogger.errorForLog(err));
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
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		serverItcHandlers.resourceHandler();
	} catch (err) {
		hdbLogger.error(hdbLogger.errorForLog(err));
	}
}

export async function signalUserChange(message: any) {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		await Promise.all([serverItcHandlers.user(itcEventUser), sendItcEvent(itcEventUser)]);
	} catch (err) {
		hdbLogger.error(hdbLogger.errorForLog(err));
	}
}
