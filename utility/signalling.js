'use strict';

const hdbTerms = require('./hdbTerms.ts');
const hdbUtils = require('./common_utils.js');
const hdbLogger = require('../utility/logging/harper_logger.js');
const ITCEventObject = require('../server/itc/utility/ITCEventObject.js');
let serverItcHandlers;
const { sendItcEvent } = require('../server/threads/itc.js');

function signalSchemaChange(message) {
	try {
		hdbLogger.debug('signalSchemaChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventSchema = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.SCHEMA, message);
		serverItcHandlers.schema(itcEventSchema);
		return sendItcEvent(itcEventSchema);
	} catch (err) {
		hdbLogger.error(err);
	}
}

function signalUserChange(message) {
	try {
		hdbLogger.trace('signalUserChange called with message:', message);
		serverItcHandlers = serverItcHandlers || require('../server/itc/serverHandlers.js');
		const itcEventUser = new ITCEventObject(hdbTerms.ITC_EVENT_TYPES.USER, message);
		serverItcHandlers.user(itcEventUser);
		return sendItcEvent(itcEventUser);
	} catch (err) {
		hdbLogger.error(err);
	}
}

module.exports = {
	signalSchemaChange,
	signalUserChange,
};
