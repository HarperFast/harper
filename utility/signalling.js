const harper_logger = require('../utility/logging/harper_logger');
const global_schema = require('../utility/globalSchema');
const terms = require('./hdbTerms');

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

class ClusterStatusSignalObject {
    constructor() {
        this.type = terms.CLUSTER_MESSAGE_TYPE_ENUM.CLUSTER_STATUS;
        // For now we want to target the creating process to send the response to this message.
        this.target_process_id = process.pid;
    }
}

class ChildStartedSignalObject {
    constructor(pid) {
        this.type = terms.CLUSTER_MESSAGE_TYPE_ENUM.CHILD_STARTED;
        this.pid = pid;
    }
}

function signalSchemaChange(message){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send === undefined || global.isMaster) {
            global_schema.schemaSignal((err) => {
                if (err) {
                    harper_logger.error(err);
                }
            });
        } else if(!global.isMaster){
            process.send(message);
        } else {
            harper_logger.warn(`Got schema change, but process.send is undefined and I am not master. My pid is ${process.pid}.  Global.isMaster is: ${global.isMaster}`);
        }
    }catch(e){
        harper_logger.error(e);
        global_schema.schemaSignal((err) => {
            if (err) {
                harper_logger.error(err);
            }
        });
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

function signalClusterStatus(){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined && !global.isMaster) {
            process.send(new ClusterStatusSignalObject());
        } else {
            harper_logger.warn('Only 1 process is running, but a signal has been invoked.  Signals will be ignored when only 1 process is running.');
        }
    } catch(e){
        harper_logger.error(e);
    }
}

function signalChildStarted() {
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
    try {

        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined && !global.isMaster) {
            process.send(new RestartSignalObject(force));
        } else {
            err = 'Only 1 process is running, but a signal has been invoked.  Signals will be ignored when only 1 process is running.';
            harper_logger.warn(err);
            result = null;
        }
    } catch(e){
        err = 'Got an error restarting HarperDB.  Please check the logs and try again.';
        harper_logger.error(e);
        result = null;
    }
}

module.exports = {
    signalSchemaChange,
    signalUserChange,
    signalJobAdded: signalJobAdded,
    signalClusterStatus: signalClusterStatus,
    JobAddedSignalObject: JobAddedSignalObject,
    signalChildStarted: signalChildStarted,
    signalRestart: signalRestart
};