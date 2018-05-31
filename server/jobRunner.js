'use strict';

const fs = require('fs');
const hdb_util = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const JobObject = require('./JobObject');
const UpdateObject = require('../data_layer/UpdateObject');
const insert = require('../data_layer/insert');
const moment = require('moment');
const csv_bulk_load = require('../data_layer/csvBulkLoad');
const {promisify} = require('util');
const log = require('../utility/logging/harper_logger');
const jobs = require('./jobs');

//Promisified functions
const p_insert_update = promisify(insert.update);
//const p_csv_data_load = csv_bulk_load.csvDataLoad;

class ParserResponse {
    constructor(success, message, error) {
        this.success = success;
        this.message = message;
        this.error = error;
    }
}

class ParserMessage {
    constructor(job, message_json) {
        this.job = job;
        this.json = message_json;
    }
}

async function updateJob(job_id, job_status, error, message, user) {
    let job_object = new JobObject();
    if(hdb_util.isEmptyOrZeroLength(job_id)) {
        return hdb_util.errorizeMessage('invalid ID passed to updateJob');
    }
    job_object.id = job_id;
    if(!hdb_util.isEmptyOrZeroLength(job_status)) {
        job_object.status = job_status;
    }
    if(!hdb_util.isEmptyOrZeroLength(error)) {
        job_object.error = error;
    }
    if(!hdb_util.isEmptyOrZeroLength(message)) {
        job_object.message = message;
    }
    if(job_status === hdb_terms.JOB_STATUS_ENUM.COMPLETE || job_status === hdb_terms.JOB_STATUS_ENUM.ERROR) {
        job_object.end_time = moment().valueOf();
    }
    if(!hdb_util.isEmptyOrZeroLength(user)) {
        job_object.user = user;
    }
    let update_object = new UpdateObject(hdb_terms.OPERATIONS_ENUM.UPDATE, hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.JOB_TABLE_NAME, [job_object]);
    // TODO: Make sure to add the record to the update object.
    let update_result = await p_insert_update(update_object);
    return update_result;
}

async function parseMessage(message) {
    let response = new ParserResponse(false,"","");
    if(hdb_util.isEmptyOrZeroLength(message.runnerMessage.json.operation)) {
        response.error = 'Invalid operation';
        return response;
    }
    if(hdb_util.isEmptyOrZeroLength(message.runnerMessage.job.id)) {
        response.error = 'Empty job id specified';
        return response;
    }

    switch(message.runnerMessage.json.operation) {
        case hdb_terms.JOB_TYPE_ENUM.csv_file_upload:
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_url_load:
            break;
        case hdb_terms.JOB_TYPE_ENUM.csv_data_load:
            let result_message = undefined;
            try {
                let update_result = await updateJob(message.runnerMessage.job.id, hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS, null, null, message.runnerMessage.json.hdb_user.username);
                //let update_result = await jobs.updateJob(message.runnerMessage.json);
                result_message = await csv_bulk_load.csvDataLoad(message.runnerMessage.json);
                //log.info(`updated ${update_result}`);
            } catch(e) {
                let err_message =`There was an error running CSV_FILE_UPLOAD job with id ${message.runnerMessage.job.id} - ${e}`;
                log.error(err_message);
                response.error = err_message;
                response.success = false;
            }
            if(result_message instanceof Error) {
                await updateJob(message.runnerMessage.job.id, hdb_terms.JOB_STATUS_ENUM.ERROR, result_message.error, null);
                response.error = result_message.error;
            } else {
                await updateJob(message.runnerMessage.job.id, hdb_terms.JOB_STATUS_ENUM.COMPLETE, null, result_message);
                response.message = result_message;
                response.success = true;
            }
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
    ParserResponse: ParserResponse,
    parseMessage: parseMessage,
    ParserMessage: ParserMessage
}