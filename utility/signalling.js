'use strict';

const hdb_terms = require('./hdbTerms');
const hdb_utils = require('./common_utils');
const hdb_logger = require('../utility/logging/harper_logger');
const IPCEventObject = require('../server/ipc/utility/IPCEventObject');
const { sendIpcEvent } = require('../server/ipc/utility/ipcUtils');

function signalSchemaChange(message){
    try {
        hdb_logger.trace(`signalSchemaChange called with message: ${JSON.stringify(message)}`);
        const ipc_event_schema = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.SCHEMA, message);
        sendIpcEvent(ipc_event_schema);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalUserChange(message){
    try {
        hdb_logger.trace(`signalUserChange called with message: ${JSON.stringify(message)}`);
        const ipc_event_user = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.USER, message);
        sendIpcEvent(ipc_event_user);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalChildStarted(message) {
    try {
        hdb_logger.trace(`signalChildStarted called with message: ${JSON.stringify(message)}`);
        const ipc_event_child_start = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.CHILD_STARTED, message);
        sendIpcEvent(ipc_event_child_start);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalChildStopped(message) {
    try {
        hdb_logger.trace(`signalChildStopped called with message: ${JSON.stringify(message)}`);
        const ipc_event_child_stop = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.CHILD_STOPPED, message);
        sendIpcEvent(ipc_event_child_stop);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalRestart(message) {
    const force_boolean = hdb_utils.autoCast(message.force);

    if (typeof force_boolean !== 'boolean') {
        hdb_logger.error('Invalid force value, must be a boolean.');
        throw new Error('Invalid force value, must be a boolean.');
    }

    try {
        hdb_logger.trace(`signalRestart called with message: ${JSON.stringify(message)}`);
        const ipc_event_restart = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.RESTART, message);
        sendIpcEvent(ipc_event_restart);
    } catch(err) {
        hdb_logger.error(err);
    }
}

module.exports = {
    signalSchemaChange,
    signalUserChange,
    signalChildStarted,
    signalChildStopped,
    signalRestart
};
