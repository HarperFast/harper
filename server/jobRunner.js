'use strict';

const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const moment = require('moment');
const csv_bulk_load = require('../data_layer/csvBulkLoad');
const log = require('../utility/logging/harper_logger');
const jobs = require('./jobs');

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
    response.job_id = runner_message.job.id;
    if(Object.keys(runner_message).length === 0) {
        throw new Error('Empty runner message passed to parseMessage');
    }
    if(Object.keys(runner_message.json).length === 0) {
        throw new Error('Empty JSON passed to parseMessage');
    }
    if(Object.keys(runner_message.job).length === 0) {
        throw new Error('Empty job passed to parseMessage');
    }
    if(hdb_util.isEmptyOrZeroLength(runner_message.json.operation)) {
        throw new Error('Invalid operation');
    }
    if(hdb_util.isEmptyOrZeroLength(runner_message.job.id)) {
        throw new Error('Empty job id specified');
    }

    response.job_id = runner_message.job.id;
    let result_message = undefined;
    switch(runner_message.json.operation) {
        case hdb_terms.JOB_TYPE_ENUM.csv_file_load:
            try {
                response = await runCSVJob(runner_message, csv_bulk_load.csvFileLoad, runner_message.json);
            } catch(e) {
                log.error(e);
            }
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_url_load:
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_data_load:
            //TODO: Hopefully most of the work below can be moved into a common function to be shared among all cases.
            try {
                runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS;
                runner_message.job.start_datetime = moment().valueOf();
                await jobs.updateJob(runner_message.job);
                result_message = await csv_bulk_load.csvDataLoad(runner_message.json);
                log.info(`performed bulk load with result ${result_message}`);
            } catch(e) {
                let err_message =`There was an error running csv_data_load job with id ${runner_message.job.id} - ${e}`;
                log.error(err_message);
                runner_message.job.message = err_message;
                runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.ERROR;
                runner_message.job.end_datetime = moment().valueOf();
                try {
                    await jobs.updateJob(runner_message.job);
                } catch(ex) {
                    log.fatal(`Unable to update job with id ${response.job_id}.  Exiting.`);
                    throw new Error(ex);
                }
                throw new Error(err_message + e);
            }
            runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.COMPLETE;
            runner_message.job.message = result_message;
            runner_message.job.end_datetime = moment().valueOf();
            try {
                await jobs.updateJob(runner_message.job);
            } catch(e) {
                log.error(e);
                throw new Error(e);
            }
            response.message = result_message;
            response.success = true;
            break;
        case hdb_terms.JOB_TYPE_ENUM.empty_trash:
            break;
        case hdb_terms.JOB_TYPE_ENUM.export_local:
            break;
        case hdb_terms.JOB_TYPE_ENUM.export_to_s3:
            break;
        case hdb_terms.JOB_TYPE_ENUM.delete_files_before:
            break;
        default:
            response.error = `Invalid operation ${runner_message.operation} specified`;
            break;
    }
    return response;
}

async function runCSVJob(runner_message, operation, argument) {
    let result_message = undefined;
    let response = new RunnerResponse(false,"","");
    try {
        runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS;
        runner_message.job.start_datetime = moment().valueOf();
        await jobs.updateJob(runner_message.job);
        //result_message = await csv_bulk_load.csvDataLoad(runner_message.json);
        result_message = operation(runner_message.json);
        log.info(`performed bulk load with result ${result_message}`);
    } catch(e) {
        let err_message =`There was an error running csv_data_load job with id ${runner_message.job.id} - ${e}`;
        log.error(err_message);
        runner_message.job.message = err_message;
        runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.ERROR;
        runner_message.job.end_datetime = moment().valueOf();
        try {
            await jobs.updateJob(runner_message.job);
        } catch(ex) {
            log.fatal(`Unable to update job with id ${response.job_id}.  Exiting.`);
            throw new Error(ex);
        }
        throw new Error(err_message + e);
    }
    runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.COMPLETE;
    runner_message.job.message = result_message;
    runner_message.job.end_datetime = moment().valueOf();

    try {
        await jobs.updateJob(runner_message.job);
    } catch(e) {
        log.error(e);
        throw new Error(e);
    }
    response.message = result_message;
    response.success = true;
}

module.exports = {
    RunnerResponse: RunnerResponse,
    parseMessage: parseMessage,
    RunnerMessage: RunnerMessage
};