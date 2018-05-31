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

//Promisified functions
const p_insert_update = insert.update;
const p_csv_data_load = csv_bulk_load.csvDataLoad;

class ParserResponse {
    constructor(success, message, error) {
        this.success = result;
        this.message = message;
        this.error = error;
    }
}

async function updateJob(job_id, job_status, error, message) {
    let job_object = new JobObject(job_id, null, null, null);
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
    let update_object = new UpdateObject(hdb_terms.OPERATIONS_ENUM.UPDATE, hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.JOB_TABLE_NAME);
    // TODO: Make sure to add the record to the update object.
    let update_result = await p_insert_update(update_object);
    return update_result;
}

async function parseMessage(message) {
    let response = new ParserResponse(false,"","");
    if(hdb_util.isEmptyOrZeroLength(message.operation)) {
        response.error = 'Invalid operation';
        return response;
    }
    if(hdb_util.isEmptyOrZeroLength(message.id)) {
        response.error = 'Empty job id specified';
        return response;
    }

    switch(message.operation) {
        case hdb_terms.JOB_TYPE_ENUM.CSV_FILE_UPLOAD:
            let result_message = undefined;
            try {
                await updateJob(message.id, hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS, null, null);
                result_message = await p_csv_data_load(message.message_body);
            } catch(e) {
                let err_message =`There was an error running CSV_FILE_UPLOAD job with id ${message.id} - ${e}`;
                log.error(err_message);
                response.error = err_message;
                response.success = false;
            }
            if(result_message instanceof Error) {
                await updateJob(message.id, hdb_terms.JOB_STATUS_ENUM.ERROR, result_message.error, null);
                response.error = result_message.error;
            } else {
                await updateJob(message.id, hdb_terms.JOB_STATUS_ENUM.COMPLETE, null, result_message);
                response.message = result_message;
                response.success = true;
            }
            return result_message;
            break;
        case hdb_terms.JOB_TYPE_ENUM.CSV_URL_LOAD:
            break;
        case hdb_terms.JOB_TYPE_ENUM.CSV_DATA_LOAD:
            break;
        case hdb_terms.JOB_TYPE_ENUM.EMPTY_TRASH:
            break;
        case hdb_terms.JOB_TYPE_ENUM.EXPORT_LOCAL:
            break;
        case hdb_terms.JOB_TYPE_ENUM.EXPORT_TO_S3:
            break;
        case hdb_terms.JOB_TYPE_ENUM.TTL:
            break;
        default:
            response.error = `Invalid operation ${message.operation} specified`;
            return response;
    }
}

module.exports = {
    ParserResponse: ParserResponse,
    parseMessage: parseMessage
}