'use strict';

const hdb_terms = require('./hdbTerms');
const hdb_utils = require('./common_utils');
const hdb_logger = require('../utility/logging/harper_logger');
const IPCEventObject = require('../server/ipc/utility/IPCEventObject');
const { sendItcEvent } = require('../server/threads/itc');

function signalSchemaChange(message) {
	try {
		hdb_logger.trace('signalSchemaChange called with message:', message);
		const ipc_event_schema = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.SCHEMA, message);
		sendItcEvent(ipc_event_schema);
	} catch (err) {
		hdb_logger.error(err);
	}
}

function signalUserChange(message) {
	try {
		hdb_logger.trace('signalUserChange called with message:', message);
		const ipc_event_user = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.USER, message);
		sendItcEvent(ipc_event_user);
	} catch (err) {
		hdb_logger.error(err);
	}
}

module.exports = {
	signalSchemaChange,
	signalUserChange,
};
