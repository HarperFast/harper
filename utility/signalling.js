'use strict';

const hdb_terms = require('./hdbTerms');
const hdb_utils = require('./common_utils');
const hdb_logger = require('../utility/logging/harper_logger');
const ITCEventObject = require('../server/itc/utility/ITCEventObject');
let server_itc_handlers;
const { sendItcEvent } = require('../server/threads/itc');

function signalSchemaChange(message) {
	try {
		hdb_logger.info('signalSchemaChange called with message:', message);
		server_itc_handlers = server_itc_handlers || require('../server/itc/serverHandlers');
		const itc_event_schema = new ITCEventObject(hdb_terms.ITC_EVENT_TYPES.SCHEMA, message);
		server_itc_handlers.schema(itc_event_schema);
		return sendItcEvent(itc_event_schema);
	} catch (err) {
		hdb_logger.error(err);
	}
}

function signalUserChange(message) {
	try {
		hdb_logger.trace('signalUserChange called with message:', message);
		server_itc_handlers = server_itc_handlers || require('../server/itc/serverHandlers');
		const itc_event_user = new ITCEventObject(hdb_terms.ITC_EVENT_TYPES.USER, message);
		server_itc_handlers.user(itc_event_user);
		return sendItcEvent(itc_event_user);
	} catch (err) {
		hdb_logger.error(err);
	}
}

module.exports = {
	signalSchemaChange,
	signalUserChange,
};
