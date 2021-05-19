'use strict';

const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const moment = require('moment');
const bulk_load = require('../data_layer/bulkLoad');
const log = require('../utility/logging/harper_logger');
const jobs = require('./jobs');
const hdb_export = require('../data_layer/export');
const hdb_delete = require('../data_layer/delete');
const fork = require('child_process').fork;
const path = require('path');
const JOB_THREAD_MODULE_PATH = path.join(__dirname, 'jobThread');
const signal = require('../utility/signalling');

class RunnerResponse {
    constructor(success, message, error) {
        this.success = success;
        this.message = message;
        this.error = error;
    }
}

class RunnerMessage {
    constructor(job_object, message_json) {
        this.job = job_object;
        this.json = message_json;
    }
}

/**
 * Parses a RunnerMessage and runs the specified job.
 * @param runner_message
 * @returns {Promise<RunnerResponse>}
 * @throws Error
 */
async function parseMessage(runner_message) {
    let response = new RunnerResponse(false,"","");

    if(!runner_message || Object.keys(runner_message).length === 0) {
        throw new Error('Empty runner passed to parseMessage');
    }
    if(!runner_message.json || Object.keys(runner_message.json).length === 0) {
        throw new Error('Empty JSON passed to parseMessage');
    }
    if(!runner_message.job || Object.keys(runner_message.job).length === 0) {
        throw new Error('Empty job passed to parseMessage');
    }
    if(hdb_util.isEmptyOrZeroLength(runner_message.json.operation)) {
        throw new Error('Invalid operation');
    }
    if(hdb_util.isEmptyOrZeroLength(runner_message.job.id)) {
        throw new Error('Empty job id specified');
    }

    response.job_id = runner_message.job.id;
    switch(runner_message.json.operation) {
        case hdb_terms.JOB_TYPE_ENUM.csv_file_load:
            try {
                response = await runCSVJob(runner_message, bulk_load.csvFileLoad, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_url_load:
            try {
                response = await runCSVJob(runner_message, bulk_load.csvURLLoad, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_data_load:
            try {
                response = await runCSVJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.import_from_s3:
            try {
                response = await runCSVJob(runner_message, bulk_load.importFromS3, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.empty_trash:
            break;
        case hdb_terms.JOB_TYPE_ENUM.export_local:
            try {
                response = await runCSVJob(runner_message, hdb_export.export_local, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.export_to_s3:
            try {
                response = await runCSVJob(runner_message, hdb_export.export_to_s3, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.delete_files_before:
        case hdb_terms.JOB_TYPE_ENUM.delete_records_before:
            try {
                response = await runCSVJob(runner_message, hdb_delete.deleteFilesBefore, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.delete_transaction_logs_before:
            try {
                response = await runCSVJob(runner_message, hdb_delete.deleteTransactionLogsBefore, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        default:
            response.error = `Invalid operation ${runner_message.json.operation} specified`;
            break;
    }
    return response;
}

/**
 * Helper function to run the specified operation using the job update 'workflow'.
 * @param runner_message - The RunnerMessage created by the signal flow
 * @param operation - The operation to run.
 * @param argument - Arguments to pass for the operation.
 * @returns {Promise<RunnerResponse>}
 */
async function runCSVJob(runner_message, operation, argument) {
    if(!runner_message || Object.keys(runner_message).length === 0) {
        throw new Error('Empty runner message passed to runCSVJob');
    }
    if(!runner_message.json || Object.keys(runner_message.json).length === 0) {
        throw new Error('Empty JSON passed to runCSVJob');
    }
    if(!runner_message.job || Object.keys(runner_message.job).length === 0) {
        throw new Error('Empty job passed to runCSVJob');
    }
    if(hdb_util.isEmptyOrZeroLength(runner_message.json.operation)) {
        throw new Error('Invalid operation');
    }
    if(hdb_util.isEmptyOrZeroLength(runner_message.job.id)) {
        throw new Error('Empty job id specified');
    }

    let result_message = undefined;
    let response = new RunnerResponse(false,"","");
    try {
        runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS;
        runner_message.job.start_datetime = moment().valueOf();
        // Update with "IN PROGRESS"
        await jobs.updateJob(runner_message.job);
        // Run the operation.
        result_message = await threadExecute(argument);
    } catch(e) {
        let err_message = e.message !== undefined ? e.message : e;
        if (typeof err_message === 'string') {
            err_message = `There was an error running ${operation.name} job with id ${runner_message.job.id} - ${err_message}`;
            e.message = err_message;
        } else {
            //This ensures that the op/job id error is logged if the error message is passed as a non-string which will
            // be logged right after this below.  If the message is a string, everything will be logged below as the err_message
            log.error(`There was an error running ${operation.name} job with id ${runner_message.job.id}`);
        }
        log.error(err_message);
        runner_message.job.message = err_message;
        runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.ERROR;
        runner_message.job.end_datetime = moment().valueOf();
        try {
            // Update with "Error"
            await jobs.updateJob(runner_message.job);
        } catch(ex) {
            log.fatal(`Unable to update job with id ${response.job_id}.  Exiting.`);
            throw new Error(ex);
        }
        throw e;
    }
    runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.COMPLETE;
    runner_message.job.message = result_message;
    runner_message.job.end_datetime = moment().valueOf();

    try {
        // Update with "COMPLETE"
        await jobs.updateJob(runner_message.job);
        log.info(`Completed running job with id: ${runner_message.job.id}`);
    } catch(e) {
        log.error(e);
        throw new Error(e);
    }
    response.message = result_message;
    response.success = true;
    return response;
}

/**
 * launches & handles response for background process to run job
 * @param argument
 * @returns {Promise<unknown>}
 */
function threadExecute(argument){
    return new Promise((resolve, reject)=>{
        const forked = fork(JOB_THREAD_MODULE_PATH);
        forked.send(argument);
        // TODO: Will this on message listener need updating
        forked.on('message', async data=>{
            if(data.hasOwnProperty('error')){
                let err = new Error();
                err.message = data.error;
                err.stack = data.stack;
                forked.kill("SIGINT");
                reject(err);
            } else if(data.hasOwnProperty('thread_results')){
                //we have this if statement to stop false processing from schema signalling
                forked.kill("SIGINT");
                resolve(data.thread_results);
            } else if(data.type === hdb_terms.IPC_EVENT_TYPES.SCHEMA){
                // TODO: Ask Kyle about this - why are we sending it just 'schema'
                signal.signalSchemaChange(hdb_terms.IPC_EVENT_TYPES.SCHEMA);
            }
        });

        forked.on('exit', (code, exit_signal) => {
            if (exit_signal === 'SIGKILL' || exit_signal === 'SIGABRT') {
                reject(new Error(`Job exited with signal: ${exit_signal}`));
            }
        });

        forked.on('error', data=>{
            forked.kill("SIGINT");
            reject(data);
        });
    });
}

module.exports = {
    RunnerResponse: RunnerResponse,
    parseMessage: parseMessage,
    RunnerMessage: RunnerMessage
};
