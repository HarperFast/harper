'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
let serverItcHandlers;
import { sendItcEvent, sendItcEventStrict } from '../server/threads/itc.js';

// Await BOTH the local handler and the cross-worker broadcast. The local handler is what
// rebuilds THIS thread's cache; firing it un-awaited let the originating worker return success
// before its own cache caught up, so the next request it served observed stale state even though
// the op awaited propagation to the other workers — the originator half of #1497. Both legs
// resolve without rejecting (each handler has its own try/catch; the broadcast always resolves),
// so Promise.all is safe here. Destructive abort/completion can order peers first so the local
// admission fence remains in place until remote workers have processed the same transition.
export async function signalSchemaChange(
	message: any,
	{ peersFirst = false, includeJobWorkers = false }: { peersFirst?: boolean; includeJobWorkers?: boolean } = {}
) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		if (peersFirst) {
			await sendItcEvent(itcEventSchema, includeJobWorkers);
			await serverItcHandlers.schema(itcEventSchema);
		} else
			await Promise.all([serverItcHandlers.schema(itcEventSchema), sendItcEvent(itcEventSchema, includeJobWorkers)]);
	} catch (err) {
		hdbLogger.error(err);
	}
}

/** Prepare peer workers for destructive DDL without applying the completion event locally. */
export async function signalSchemaChangeToPeers(message: any): Promise<void> {
	hdbLogger.debug('signalSchemaChangeToPeers called with message:', message);
	const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
	// Native derived-index shutdown has a 70-second backstop. The extra round closes the topology
	// race: after the main thread installs the preparation fence, any worker started during round one
	// inherits it and is present for round two.
	for (let round = 0; round < 2; round++) {
		await sendItcEventStrict(itcEventSchema, 90_000, true);
		if (round === 0) await new Promise(setImmediate);
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
		hdbLogger.error(err);
	}
}
