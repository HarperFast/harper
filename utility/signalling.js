'use strict';

const harper_logger = require('../utility/logging/harper_logger');
const hdb_terms = require('./hdbTerms');
const common = require('./common_utils');
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

const SCHEMA_CHANGE_MESSAGE = {
    type: hdb_terms.SCHEMA_DIR_NAME
};

function signalSchemaChange(message){
    try {
        const ipc_event_schema = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.SCHEMA, message);
        sendIpcEvent(ipc_event_schema);
    } catch(err) {
        harper_logger.error(err);
    }
}

function signalUserChange(message){
    try {
        const ipc_event_user = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.USER, message);
        sendIpcEvent(ipc_event_user);
    } catch(err) {
        harper_logger.error(err);
    }
}

function signalJobAdded(message){
    try {
        const job_added_msg = new JobAddedSignalMessage(message);
        const ipc_event_job = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.JOB, job_added_msg);
        sendIpcEvent(ipc_event_job);
    } catch(err) {
        harper_logger.error(err);
    }
}

function signalChildStarted() {
    try {
        harper_logger.debug(`Sending child started signal from process ${process.pid}`);
        const ipc_event_child = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.CHILD_STARTED, process.pid);
        sendIpcEvent(ipc_event_child);
    } catch(err) {
        harper_logger.error(err);
    }
}

function signalRestart(force) {
    const force_boolean = common.autoCast(force);

    if (typeof force_boolean !== 'boolean') {
        harper_logger.error('Invalid force value, must be a boolean.');
        throw new Error('Invalid force value, must be a boolean.');
    }

    try {
        const ipc_event_restart = new IPCEventObject(hdb_terms.IPC_EVENT_TYPES.RESTART, force_boolean);
        sendIpcEvent(ipc_event_restart);
    } catch(err) {
        harper_logger.error(err);
    }
}

module.exports = {
    signalSchemaChange,
    signalUserChange,
    signalJobAdded: signalJobAdded,
    signalChildStarted: signalChildStarted,
    signalRestart: signalRestart,
    SCHEMA_CHANGE_MESSAGE
};

