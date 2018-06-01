'use strict';

const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const JobObject = require('./JobObject');
const moment = require('moment');
const csv_bulk_load = require('../data_layer/csvBulkLoad');
const {promisify} = require('util');
const log = require('../utility/logging/harper_logger');
const jobs = require('./jobs');

class RunnerResponse {
    constructor(success, message, error) {
        this.success = success;
        this.message = message;
        this.error = error;
        this.job_id;
    }
}

class RunnerMessage {
    constructor(job_object, message_json) {
        this.job = job_object;
        this.json = message_json;
    }
}

async function parseMessage(message) {
    let response = new RunnerResponse(false,"","");
    response.job_id = message.runner_message.job.id;
    if(hdb_util.isEmptyOrZeroLength(message.runner_message.json.operation)) {
        throw new Error('Invalid operation');
    }
    if(hdb_util.isEmptyOrZeroLength(message.runner_message.job.id)) {
        throw new Error('Empty job id specified');
    }
    response.job_id = message.runner_message.job.id;
    let result_message = undefined;
    switch(message.runner_message.json.operation) {
        case hdb_terms.JOB_TYPE_ENUM.csv_file_upload:
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_url_load:
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_data_load:
            try {
                message.runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS;
                message.runner_message.job.start_datetime = moment().valueOf();
                await jobs.updateJob(message.runner_message.job);
                result_message = await csv_bulk_load.csvDataLoad(message.runner_message.json);
                log.info(`performed bulk load with result ${result_message}`);
            } catch(e) {
                let err_message =`There was an error running csv_data_load job with id ${message.runner_message.job.id} - ${e}`;
                log.error(err_message);
                message.runner_message.job.message = err_message;
                message.runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.ERROR;
                message.runner_message.job.end_datetime = moment().valueOf();
                await jobs.updateJob(message.runner_message.job);
                throw new Error(err_message + e);
            }
            message.runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.COMPLETE;
            message.runner_message.job.status = result_message;
            message.runner_message.job.end_datetime = moment().valueOf();
            await jobs.updateJob(message.runner_message.job);
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
            response.error = `Invalid operation ${message.operation} specified`;
            break;
    }
    return response;
}

module.exports = {
    RunnerResponse: RunnerResponse,
    parseMessage: parseMessage,
    RunnerMessage: RunnerMessage
}