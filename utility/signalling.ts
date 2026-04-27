'use strict';

import * as hdbTerms from './hdbTerms.js';
import * as hdbLogger from '../utility/logging/harper_logger.js';
import ITCEventObject from '../server/itc/utility/ITCEventObject.js';
let serverItcHandlers: any;
import { sendItcEvent } from '../server/threads/itc.js';

export async function signalSchemaChange(message: any): Promise<any> {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		const loadedHandlers = require('../server/itc/serverHandlers.js');
		serverItcHandlers = loadedHandlers.default || loadedHandlers;
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		serverItcHandlers.schema(itcEventSchema);
		return sendItcEvent(itcEventSchema);
	} catch (err) {
		hdbLogger.error(err as any);
	}
}

export async function signalUserChange(message: any): Promise<any> {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		const loadedHandlers = require('../server/itc/serverHandlers.js');
		serverItcHandlers = loadedHandlers.default || loadedHandlers;
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		serverItcHandlers.user(itcEventUser);
		return sendItcEvent(itcEventUser);
	} catch (err) {
		hdbLogger.error(err as any);
	}
}
