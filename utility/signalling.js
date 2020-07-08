const harper_logger = require('../utility/logging/harper_logger');
const terms = require('./hdbTerms');
const common = require('./common_utils');

class JobAddedSignalObject {
    constructor(job_id, runner_message) {
        this.runner_message = runner_message;
        this.type = terms.CLUSTER_MESSAGE_TYPE_ENUM.JOB;
        // For now we want to target the creating process to handle this job.  At some point this can
        // be made smarter to delegate to a different process.
        this.target_process_id = process.pid;
    }
}

class RestartSignalObject {
    constructor(force) {
        this.force_shutdown = force;
        this.type = terms.CLUSTER_MESSAGE_TYPE_ENUM.RESTART;
    }
}

class ChildStartedSignalObject {
    constructor(pid) {
        this.type = terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STARTED;
        this.pid = pid;
    }
}

const SCHEMA_CHANGE_MESSAGE = {
    type: terms.SCHEMA_DIR_NAME
};

function signalSchemaChange(message){
    try {
        if(!global.isMaster){
            process.send(message);
        } else {
            harper_logger.warn(`Got schema change, but process.send is undefined and I am not parent. My pid is ${process.pid}.  Global.isMaster is: ${global.isMaster}`);
        }
    }catch(e){
        harper_logger.error(e);
    }
}

function signalUserChange(message){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined && !global.isMaster) {
            process.send(message);
        } else {
            //TODO: Can't call user schema directly, circular dependency.  FIX THIS,
        }
    } catch(e){
        harper_logger.error(e);
    }
}

function signalJobAdded(job_added_signal_object){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined && !global.isMaster) {
            process.send(job_added_signal_object);
        } else {
            harper_logger.warn('Only 1 process is running, but a signal has been invoked.  Signals will be ignored when only 1 process is running.');
        }

    } catch(e){
        harper_logger.error(e);
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
    JobAddedSignalObject: JobAddedSignalObject,
    signalChildStarted: signalChildStarted,
    signalRestart: signalRestart,
    SCHEMA_CHANGE_MESSAGE
};

