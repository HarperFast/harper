const harper_logger = require('../utility/logging/harper_logger');
const global_schema = require('../utility/globalSchema');
const process = require('process');
//const jobs = require('../server/jobs');
//const job_runner = require('../server/jobRunner');

class JobAddedSignalObject {
    constructor(job_id, runner_message) {
        this.runner_message = runner_message;
        this.type = 'job';
        // For now we want to target the creating process to handle this job.  At some point this can
        // be made smarter to delegate to a different process.
        this.target_process_id = process.pid;
    }
}

function signalSchemaChange(message){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send === undefined) {
            global_schema.schemaSignal((err) => {
                if (err) {
                    harper_logger.error(err);
                }
            });
        } else {
            process.send(message);
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
        if (process.send !== undefined) {
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
        if (process.send !== undefined) {
            process.send(job_added_signal_object);
        } else {
            //TODO: Can't call job runner or jobs directly as it creates a circular dependency.  Find a way around it.
        }

    } catch(e){
        harper_logger.error(e);
    }
}

module.exports = {
    signalSchemaChange,
    signalUserChange,
    signalJobAdded: signalJobAdded,
    JobAddedSignalObject: JobAddedSignalObject
};