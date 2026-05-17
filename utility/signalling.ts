'use strict';

import * as hdbTerms from './hdbTerms.ts';
import hdbLogger from '../utility/logging/harper_logger.ts';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
let serverItcHandlers;
import { sendItcEvent } from '../server/threads/itc.ts';

export async function signalSchemaChange(message: any) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		serverItcHandlers = serverItcHandlers || (await import('../server/itc/serverHandlers.ts'));
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		serverItcHandlers.schema(itcEventSchema);
		return sendItcEvent(itcEventSchema);
	} catch (err) {
		hdbLogger.error(err);
	}
}

export async function signalUserChange(message: any) {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		serverItcHandlers = serverItcHandlers || (await import('../server/itc/serverHandlers.ts'));
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		serverItcHandlers.user(itcEventUser);
		return sendItcEvent(itcEventUser);
	} catch (err) {
		hdbLogger.error(err);
	}
}
