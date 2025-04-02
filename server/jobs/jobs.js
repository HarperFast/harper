'use strict';

/**
 * The jobs class is used to enable operations on the jobs system table.  The jobHandler function is the only
 * exposed method to simplify the interaction.
 */

const uuidV4 = require('uuid').v4;
const insert = require('../../dataLayer/insert');
const search = require('../../dataLayer/search');
const Search_Object = require('../../dataLayer/SearchObject');
const search_by_hash_obj = require('../../dataLayer/SearchByHashObject');
const SQL_Search_Object = require('../../dataLayer/SqlSearchObject');
const hdb_terms = require('../../utility/hdbTerms');
const JobObject = require('./JobObject');
const UpdateObject = require('../../dataLayer/UpdateObject');
const log = require('../../utility/logging/harper_logger');
const Insert_Object = require('../../dataLayer/InsertObject');
const hdb_util = require('../../utility/common_utils');
const { promisify } = require('util');
const moment = require('moment');
const hdb_sql = require('../../sqlTranslator');
const file_load_validator = require('../../validation/fileLoadValidator');
const bulkDeleteValidator = require('../../validation/bulkDeleteValidator');
const { deleteTransactionLogsBeforeValidator } = require('../../validation/transactionLogValidator');
const { handleHDBError, hdb_errors, ClientError } = require('../../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;

//Promisified functions
const p_search_by_value = search.searchByValue;
const p_search_search_by_hash = search.searchByHash;
const p_insert = insert.insert;
const p_sql_evaluate = promisify(hdb_sql.evaluateSQL);
const p_insert_update = insert.update;

module.exports = {
	addJob,
	updateJob,
	handleGetJob,
	handleGetJobsByStartDate,
	getJobById,
};

async function handleGetJob(json_body) {
	if (json_body.id === undefined) throw new ClientError("'id' is required");
	let result = await getJobById(json_body.id);
	if (!hdb_util.isEmptyOrZeroLength(result)) {
		result[0] = { ...result[0] };
		if (result[0].request !== undefined) delete result[0].request;
		delete result[0]['__createdtime__'];
		delete result[0]['__updatedtime__'];
	}

	return result;
}

async function handleGetJobsByStartDate(json_body) {
	try {
		let result = await getJobsInDateRange(json_body);
		log.trace(`Searching for jobs from ${json_body.from_date} to ${json_body.to_date}`);
		if (result && result.length > 0) {
			for (let curr_res of result) {
				if (curr_res.start_datetime) {
					curr_res.start_datetime_converted = moment(curr_res.start_datetime);
				}
				if (curr_res.end_datetime) {
					curr_res.end_datetime_converted = moment(curr_res.end_datetime);
				}

				if (curr_res.request !== undefined) delete curr_res.request;
				delete curr_res['__createdtime__'];
				delete curr_res['__updatedtime__'];
			}
		}
		return result;
	} catch (err) {
		let message = `There was an error searching jobs by date: ${err}`;
		log.error(message);
		throw new Error(message);
	}
}

/**
 * Add a job to the job schema.
 * @param json_body - job descriptor defined in the endpoint.
 * @returns {Promise<*>}
 */
async function addJob(json_body) {
	let result = { message: '', error: '', success: false, createdJob: undefined };
	if (!json_body || Object.keys(json_body).length === 0 || hdb_util.isEmptyOrZeroLength(json_body.operation)) {
		let err_msg = `job parameter is invalid`;
		log.info(err_msg);
		result.error = err_msg;
		return result;
	}

	// Check for valid job type.
	if (!hdb_terms.JOB_TYPE_ENUM[json_body.operation]) {
		log.info(`invalid job type specified: ${json_body.operation}.`);
		return result;
	}

	// Validate csv operation to ensure that action is valid, schema and table exist, and if file load - check file.
	let operation = json_body.operation;
	let validation_msg;
	switch (operation) {
		case hdb_terms.OPERATIONS_ENUM.CSV_FILE_LOAD:
			validation_msg = file_load_validator.fileObject(json_body);
			break;
		case hdb_terms.OPERATIONS_ENUM.CSV_URL_LOAD:
			validation_msg = file_load_validator.urlObject(json_body);
			break;
		case hdb_terms.OPERATIONS_ENUM.CSV_DATA_LOAD:
			validation_msg = file_load_validator.dataObject(json_body);
			break;
		case hdb_terms.OPERATIONS_ENUM.IMPORT_FROM_S3:
			validation_msg = file_load_validator.s3FileObject(json_body);
			break;
		case hdb_terms.OPERATIONS_ENUM.DELETE_FILES_BEFORE:
		case hdb_terms.OPERATIONS_ENUM.DELETE_RECORDS_BEFORE:
			validation_msg = bulkDeleteValidator(json_body, 'date');
			break;
		case hdb_terms.OPERATIONS_ENUM.DELETE_AUDIT_LOGS_BEFORE:
			validation_msg = bulkDeleteValidator(json_body, 'timestamp');
			break;
		case hdb_terms.OPERATIONS_ENUM.DELETE_TRANSACTION_LOGS_BEFORE:
			validation_msg = deleteTransactionLogsBeforeValidator(json_body);
			break;
		case hdb_terms.OPERATIONS_ENUM.RESTART_SERVICE:
			if (hdb_terms.HDB_PROCESS_SERVICES[json_body.service] === undefined) {
				throw handleHDBError(new Error(), 'Invalid service', HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
			}
			break;
		default:
			break;
	}
	if (validation_msg) {
		throw handleHDBError(
			validation_msg,
			validation_msg.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let new_job = new JobObject();
	new_job.type =
		json_body.operation === hdb_terms.OPERATIONS_ENUM.DELETE_RECORDS_BEFORE
			? hdb_terms.OPERATIONS_ENUM.DELETE_FILES_BEFORE
			: json_body.operation;
	new_job.type = json_body.operation;
	new_job.user = json_body.hdb_user?.username;
	let search_obj = new Search_Object(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME,
		'id',
		new_job.id,
		'id',
		['id']
	);

	let found_job;
	try {
		found_job = Array.from(await p_search_by_value(search_obj));
	} catch (e) {
		let message = `There was an error inserting a new job: ${e}`;
		log.error(message);
		return result;
	}
	//TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
	let found_values = Array.isArray(found_job) ? found_job : Object.keys(found_job);

	// It is highly unlikely that we will ever get into this, as a UUID duplicate is very rare.  Just in case we
	// do have a collision, we regenerate an ID and search again.  The odds of 2 collisions are so astronomically high
	// that we will just throw an error assuming there is bad input causing the issue.
	if (found_values && found_values.length > 0) {
		new_job.id = uuidV4();
		try {
			found_job = await p_search_by_value(search_obj);
		} catch (e) {
			let message = `There was an error inserting a new job: ${e}`;
			log.error(message);
			return result;
		}
		//TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
		found_values = Array.isArray(found_job) ? found_job : Object.keys(found_job);
		if (found_values && found_values.length > 0) {
			log.error('Error creating a job, could not find a unique job id.');
			return result;
		}
	}

	// We save the request so that the job process can get it and run the operation.
	// Sending the request via IPC to the job process was causing some messages to be lost under load.
	new_job.request = json_body;

	let insert_object = new Insert_Object(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME,
		'id',
		[new_job]
	);
	let insert_result;
	try {
		insert_result = await p_insert(insert_object);
	} catch (e) {
		log.error(`There was an error inserting a job for job type: ${json_body.operation} -- ${e}`);
		result.success = false;
		return result;
	}

	if (insert_result.inserted_hashes.length === 0) {
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

	if (!parsed_from_date.isValid()) {
		throw new Error(`Invalid 'from' date, must be in ISO-8601 format (YYYY-MM-DD).`);
	}
	if (!parsed_to_date.isValid()) {
		throw new Error(`Invalid 'to' date, must be in ISO-8601 format (YYYY-MM-DD)`);
	}

	let job_search_sql = `select * from system.hdb_job where start_datetime > '${parsed_from_date.valueOf()}' and start_datetime < '${parsed_to_date.valueOf()}'`;
	let sql_search_obj = new SQL_Search_Object(job_search_sql, json_body.hdb_user);

	try {
		return await p_sql_evaluate(sql_search_obj);
	} catch (e) {
		log.error(
			`there was a problem searching for jobs from date ${json_body.from_date} to date ${json_body.to_date} ${e}`
		);
		throw new Error(`there was an error searching for jobs.  Please check the log for details.`);
	}
}

/**
 * Get a job by a specific id
 * @param json_body - The inbound message
 * @returns {Promise<*>}
 */
async function getJobById(job_id) {
	if (hdb_util.isEmptyOrZeroLength(job_id)) {
		return hdb_util.errorizeMessage('Invalid job ID specified.');
	}

	const search_obj = new search_by_hash_obj(
		hdb_terms.SYSTEM_SCHEMA_NAME,
		hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME,
		[job_id],
		['*']
	);

	try {
		return await p_search_search_by_hash(search_obj);
	} catch (e) {
		let message = `There was an error searching for a job by id: ${job_id} ${e}`;
		log.error(message);
		return hdb_util.errorizeMessage(`there was an error searching for jobs.  Please check the log for details.`);
	}
}

/**
 * Update the job record specified in the parameter.  If the status is COMPLETE or ERROR, the end_datetime field will be set to now().
 * @param job_object - The object representing the desired record.
 * @returns {Promise<*>}
 */
async function updateJob(job_object) {
	if (Object.keys(job_object).length === 0) {
		throw new Error('invalid job object passed to updateJob');
	}
	if (hdb_util.isEmptyOrZeroLength(job_object.id)) {
		throw new Error('invalid ID passed to updateJob');
	}

	if (
		job_object.status === hdb_terms.JOB_STATUS_ENUM.COMPLETE ||
		job_object.status === hdb_terms.JOB_STATUS_ENUM.ERROR
	) {
		job_object.end_datetime = moment().valueOf();
	}

	let update_object = new UpdateObject(hdb_terms.SYSTEM_SCHEMA_NAME, hdb_terms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, [
		job_object,
	]);
	let update_result = undefined;
	update_result = await p_insert_update(update_object);
	return update_result;
}
