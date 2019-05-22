'use strict';

/**
 * The jobs class is used to enable operations on the jobs system table.  The jobHandler function is the only
 * exposed method to simplify the interaction.
 */

const uuidV4 = require('uuid/v4');
const insert = require('../data_layer/insert');
const search = require('../data_layer/search');
const Search_Object = require('../data_layer/SearchObject');
const SQL_Search_Object = require('../data_layer/SqlSearchObject');
const Delete_Object = require('../data_layer/DeleteObject');
const hdb_terms = require('../utility/hdbTerms');
const JobObject = require('./JobObject');
const UpdateObject = require('../data_layer/UpdateObject');
const log = require('../utility/logging/harper_logger');
const Insert_Object = require('../data_layer/InsertObject');
const hdb_util = require('../utility/common_utils');
const {promisify} = require('util');
const moment = require('moment');
const hdb_sql = require('../sqlTranslator/index');
const hdb_delete = require('../data_layer/delete');
const csv_validator = require('../validation/csvValidator');

//Promisified functions
const p_search_by_value = promisify(search.searchByValue);
const p_insert = insert.insert;
const p_sql_evaluate = promisify(hdb_sql.evaluateSQL);
const p_delete = promisify(hdb_delete.delete);
const p_insert_update = insert.update;

module.exports = {
	jobHandler: jobHandler,
    addJob: addJob,
    updateJob: updateJob
};

/**
 * Handles all job related messages.  This function accepts a callback to remain compatible with chooseOperation.
 * @param json_body - The inbound message
 * @param callback - callback is supported to remain compatible with chooseOperation.
 * @returns {*}
 */
function jobHandler(json_body, callback) {
	switch(json_body.operation) {
		case 'add_job':
			addJob(json_body).then( (result) => {
				log.trace(`Added job with type ${json_body.job_type}`);
                return callback(null, result);
			}).catch(function caughtError(err) {
                let message = `There was an error adding a job: ${err}`;
				log.error(message);
                return callback(message, null);
			});
			break;
		case 'search_jobs_by_start_date':
            getJobsInDateRange(json_body).then( (result) => {
                log.trace(`Searching for jobs from ${json_body.from_date} to ${json_body.to_date}`);
                if(result && result.length > 0) {
                    for(let curr_res of result) {
                        if (curr_res.start_datetime) {
                            curr_res.start_datetime_converted = moment(curr_res.start_datetime);
                        }
                        if (curr_res.end_datetime) {
                            curr_res.end_datetime_converted = moment(curr_res.end_datetime);
                        }
                    }
                }
                return callback(null, result);
            }).catch(function caughtError(err) {
                let message = `There was an error searching jobs by date: ${err}`;
                log.error(message);
                return callback(message, null);
            });
			break;
		case 'get_job':
                getJobById(json_body).then( (result) => {
                    log.trace(`Searching for jobs from ${json_body.from_date} to ${json_body.to_date}`);
                    if(result && result.length > 0) {
                        for(let curr_res of result) {
                            if (curr_res.start_datetime) {
                                curr_res.start_datetime_converted = moment(curr_res.start_datetime);
                            }
                            if (curr_res.end_datetime) {
                                curr_res.end_datetime_converted = moment(curr_res.end_datetime);
                            }
                        }
                    }
                    return callback(null, result);
                }).catch(function caughtError(err) {
                    let message = `There was an error searching jobs by date: ${err}`;
                    log.error(message);
                    return callback(message, null);
                });
			break;
		case 'delete_job':
            deleteJobById(json_body).then( (result) => {
                log.trace(`Deleting jobs ${json_body.id}`);
                return callback(null, result);
            }).catch(function caughtError(err) {
                let message = `There was an error searching jobs by date: ${err}`;
                log.error(message);
                return callback(message, null);
            });
			break;
		default:
            return callback('Invalid operation specified.', null);
	}
}

/**
 * Add a job to the job schema.
 * @param json_body - job descriptor defined in the endpoint.
 * @returns {Promise<*>}
 */
async function addJob(json_body) {
    let result = { message: '', error: '', success: false, createdJob: undefined};
    if(!json_body || Object.keys(json_body).length === 0 || hdb_util.isEmptyOrZeroLength(json_body.operation)) {
        let err_msg = `job parameter is invalid`;
        log.info(err_msg);
        result.error = err_msg;
        return result;
	}

    // Check for valid job type.
    if(!hdb_terms.JOB_TYPE_ENUM[json_body.operation]) {
        log.info(`invalid job type specified: ${json_body.operation}.`);
        return result;
    }

    // Validate to ensure that action is valid, schema and table exist, and if file load - check file.
    await csv_validator.csvValidator(json_body);

    let new_job = new JobObject();
    new_job.type = json_body.operation;
    new_job.user = json_body.hdb_user.username;
	let search_obj = new Search_Object(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, 'id', new_job.id, 'id', 'id');
	
	let found_job = undefined;
	try {
        found_job = await p_search_by_value(search_obj);
	} catch(e) {
        let message = `There was an error inserting a new job: ${e}`;
        log.error(message);
        return result;
    }
    //TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
    let found_values = (Array.isArray(found_job) ? found_job : Object.keys(found_job));

    // It is highly unlikely that we will ever get into this, as a UUID duplicate is very rare.  Just in case we
    // do have a collision, we regenerate an ID and search again.  The odds of 2 collisions are so astronomically high
    // that we will just throw an error assuming there is bad input causing the issue.
    if(found_values && found_values.length > 0) {
        new_job.id = uuidV4();
        try {
            found_job = await p_search_by_value(search_obj);
        } catch(e) {
            let message = `There was an error inserting a new job: ${e}`;
            log.error(message);
            return result;
        }
        //TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
        found_values = (Array.isArray(found_job) ? found_job : Object.keys(found_job));
        if(found_values && found_values.length > 0) {
            log.error('Error creating a job, could not find a unique job id.');
            return result;
        }
    }

    let insert_object = new Insert_Object('insert', hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, 'id', [new_job]);
    let insert_result = undefined;
    try {
        insert_result = await p_insert(insert_object);
    } catch(e) {
        log.error(`There was an error inserting a job for job type: ${json_body.operation} -- ${e}`);
        result.success = false;
        return result;
    }

	if(insert_result.inserted_hashes.length === 0) {
		result.message = `Had a problem creating a job with type ${new_job.operation} and id ${new_job.id}`;
	} else {
        let result_msg = `Created a job with type ${new_job.type} and id ${new_job.id}`;
        result.message = result_msg;
        result.createdJob = new_job;
        result.success = true;
        log.trace(result_msg);
    }
	return result;
}

/**
 * Get jobs in a range of dates by comparing start date of the job.
 * @param json_body - The inbound message
 * @returns {Promise<*>}
 */
async function getJobsInDateRange(json_body) {
	let parsed_from_date = moment(json_body.from_date, moment.ISO_8601);
	let parsed_to_date = moment(json_body.to_date, moment.ISO_8601);

	if(!parsed_from_date.isValid()) {
        throw new Error(`Invalid 'from' date, must be in ISO-8601 format (YYYY-MM-DD).`);
    }
    if(!parsed_to_date.isValid()) {
        throw new Error(`Invalid 'to' date, must be in ISO-8601 format (YYYY-MM-DD)`);
    }

    let job_search_sql = `select * from system.hdb_job where start_datetime > '${parsed_from_date.valueOf()}' and start_datetime < '${parsed_to_date.valueOf()}'`;
    let sql_search_obj = new SQL_Search_Object(job_search_sql, json_body.hdb_user);

    try {
        return await p_sql_evaluate(sql_search_obj);
    } catch (e) {
        log.error(`there was a problem searching for jobs from date ${json_body.from_date} to date ${json_body.to_date} ${e}` );
        throw new Error(`there was an error searching for jobs.  Please check the log for details.`);
    }
}

/**
 * Get a job by a specific id
 * @param json_body - The inbound message
 * @returns {Promise<*>}
 */
async function getJobById(json_body) {
    if(hdb_util.isEmptyOrZeroLength(json_body.id)) {
        return hdb_util.errorizeMessage('Invalid job ID specified.');
    }
    let search_obj = new Search_Object(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, 'id', json_body.id, 'id', ['*']);
    try {
        return await p_search_by_value(search_obj);
    } catch(e) {
        let message = `There was an error searching for a job by id: ${json_body.id} ${e}`;
        log.error(message);
        return hdb_util.errorizeMessage(`there was an error searching for jobs.  Please check the log for details.`);
    }
}

/**
 * Delete a job by it's ID
 * @param json_body - The inbound message
 * @returns {Promise<*>}
 */
async function deleteJobById(json_body) {
    if(hdb_util.isEmptyOrZeroLength(json_body.id)) {
        return hdb_util.errorizeMessage('Invalid job ID specified.');
    }
    let delete_result = {};
    let delete_obj = new Delete_Object(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, [json_body.id]);
    try {
        delete_result.message = await p_delete(delete_obj);
    } catch(e) {
        let message = "";
        if(e.message.indexOf('not found') > 0) {
            message = `Job ID ${json_body.id} was not found.`;
        } else {
            message = `There was an error deleting a job by id: ${json_body.id} ${e}`;
        }
        log.error(message);
        delete_result.message = message;
    }
    return delete_result;
}

/**
 * Update the job record specified in the parameter.  If the status is COMPLETE or ERROR, the end_datetime field will be set to now().
 * @param job_object - The object representing the desired record.
 * @returns {Promise<*>}
 */
async function updateJob(job_object) {
    if(Object.keys(job_object).length === 0) {
        throw new Error('invalid job object passed to updateJob');
    }
    if(hdb_util.isEmptyOrZeroLength(job_object.id)) {
        throw new Error('invalid ID passed to updateJob');
    }

    if(job_object.status === hdb_terms.JOB_STATUS_ENUM.COMPLETE || job_object.status === hdb_terms.JOB_STATUS_ENUM.ERROR) {
        job_object.end_datetime = moment().valueOf();
    }

    let update_object = new UpdateObject(hdb_terms.OPERATIONS_ENUM.UPDATE, hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, [job_object]);
    let update_result = undefined;
    try {
        update_result = await p_insert_update(update_object);
    } catch(e) {
        throw new Error(e);
    }
    return update_result;
}