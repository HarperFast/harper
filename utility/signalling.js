const winston = require('../utility/logging/winston_logger');

module.exports = {
    signalSchemaChange,
    signalUserChange,
    signalJobAdded: signalJobAdded,
    JobAddedSignalObject: JobAddedSignalObject
};
const global_schema = require('../utility/globalSchema');

class JobAddedSignalObject {
    constructor(job_id, json) {
        this.job_id = job_id;
        this.json = json;
    }
}

function signalSchemaChange(message){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send === undefined) {
            global_schema.schemaSignal((err) => {
                if (err) {
                    winston.error(err);
                }
            });
        } else {
            process.send(message);
        }
    }catch(e){
        winston.error(e);
        global_schema.schemaSignal((err) => {
            if (err) {
                winston.error(err);
            }
        });
    }
}

function signalUserChange(message){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined) {
            process.send(message);
        }
    } catch(e){
        winston.error(e);
    }
}

function signalJobAdded(job_added_signal_object){
    try {
        // if process.send is undefined we are running a single instance of the process.
        if (process.send !== undefined) {
            process.send(job_added_signal_object);
        }
        //TODO: Need to manually call jobMessageParser if there is only 1 process running.
    } catch(e){
        winston.error(e);
    }
}

