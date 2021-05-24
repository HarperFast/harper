'use strict';

const hdb_terms = require('./hdbTerms');
const hdb_utils = require('./common_utils');
const hdb_logger = require('../utility/logging/harper_logger');
const IPCEventObject = require('../server/ipc/utility/IPCEventObject');
const { sendIpcEvent } = require('../server/ipc/utility/ipcUtils');

class JobAddedSignalMessage {
    constructor(runner_message) {
        // For now we want to target the creating process to handle this job.  At some point this can
        // be made smarter to delegate to a different process.
        this.target_process_id = process.pid;
        this.runner_message = runner_message;
    }
}

function signalSchemaChange(message){
    try {
        hdb_logger.trace(`signalSchemaChange called with message: ${message}`);
        const ipc_event_schema = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.SCHEMA, message);
        sendIpcEvent(ipc_event_schema);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalUserChange(message){
    try {
        hdb_logger.trace(`signalUserChange called with message: ${message}`);
        const ipc_event_user = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.USER, message);
        sendIpcEvent(ipc_event_user);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalJobAdded(message){
    try {
        hdb_logger.trace(`signalJobAdded called with message: ${message}`);
        const job_added_msg = new JobAddedSignalMessage(message);
        const ipc_event_job = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.JOB, job_added_msg);
        sendIpcEvent(ipc_event_job);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalChildStarted() {
    try {
        hdb_logger.trace(`signalChildStarted called with message: ${process.pid}`);
        const ipc_event_child_start = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.CHILD_STARTED, process.pid);
        sendIpcEvent(ipc_event_child_start);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalChildStopped() {
    try {
        hdb_logger.trace(`signalChildStopped called with message: ${process.pid}`);
        const ipc_event_child_stop = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.CHILD_STOPPED, process.pid);
        sendIpcEvent(ipc_event_child_stop);
    } catch(err) {
        hdb_logger.error(err);
    }
}

function signalRestart(force) {
    const force_boolean = hdb_utils.autoCast(force);

    if (typeof force_boolean !== 'boolean') {
        hdb_logger.error('Invalid force value, must be a boolean.');
        throw new Error('Invalid force value, must be a boolean.');
    }

    try {
        hdb_logger.trace(`signalRestart called with message: ${process.pid}`);
        const ipc_event_restart = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.RESTART, force_boolean);
        sendIpcEvent(ipc_event_restart);
    } catch(err) {
        hdb_logger.error(err);
    }
}

module.exports = {
    signalSchemaChange,
    signalUserChange,
    signalJobAdded,
    signalChildStarted,
    signalChildStopped,
    signalRestart
};
