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

class RestartSignalObject {
    constructor(force) {
        this.force_shutdown = force;
        this.type = hdb_terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART;
    }
}

class ChildStartedSignalObject {
    constructor(pid) {
        this.type = hdb_terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STARTED;
        this.pid = pid;
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
    harper_logger.debug(`Sending child started signal from process ${process.pid}`);
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined && !global.isMaster) {
            process.send(new ChildStartedSignalObject(process.pid));
        } else {
            harper_logger.warn('Only 1 process is running, but a signal has been invoked.  Signals will be ignored when only 1 process is running.');
        }
    } catch(e){
        harper_logger.error(e);
    }
}

function signalRestart(force) {
    let err = null;
    let force_boolean = common.autoCast(force);

    if (typeof force_boolean !== 'boolean') {
        harper_logger.error('Invalid force value, must be a boolean.');
        throw new Error('Invalid force value, must be a boolean.');
    }

    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined && !global.isMaster) {
            common.callProcessSend(new RestartSignalObject(force_boolean));
        } else {
            err = 'Only 1 process is running, but a signal has been invoked.  Signals will be ignored when only 1 process is running.';
            harper_logger.warn(err);
        }
    } catch(e){
        err = 'Got an error restarting HarperDB.  Please check the logs and try again.';
        harper_logger.error(e);
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

