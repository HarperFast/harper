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

export function signalSchemaChange(message: any) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		ensureServerItcHandlers();
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		serverItcHandlers?.schema(itcEventSchema);
		return sendItcEvent(itcEventSchema);
	} catch (err) {
		hdbLogger.error(err);
	}
}

export function signalUserChange(message: any) {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		ensureServerItcHandlers();
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		serverItcHandlers?.user(itcEventUser);
		return sendItcEvent(itcEventUser);
	} catch (err) {
		hdbLogger.error(err);
	}
}
