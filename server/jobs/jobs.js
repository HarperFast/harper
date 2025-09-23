'use strict';

/**
 * The jobs class is used to enable operations on the jobs system table.  The jobHandler function is the only
 * exposed method to simplify the interaction.
 */

const uuidV4 = require('uuid').v4;
const insert = require('../../dataLayer/insert.js');
const search = require('../../dataLayer/search.js');
const Search_Object = require('../../dataLayer/SearchObject.js');
const searchByHashObj = require('../../dataLayer/SearchByHashObject.js');
const SQL_Search_Object = require('../../dataLayer/SqlSearchObject.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const JobObject = require('./JobObject.js');
const UpdateObject = require('../../dataLayer/UpdateObject.js');
const log = require('../../utility/logging/harper_logger.js');
const Insert_Object = require('../../dataLayer/InsertObject.js');
const hdbUtil = require('../../utility/common_utils.js');
const { promisify } = require('util');
const moment = require('moment');
const fileLoadValidator = require('../../validation/fileLoadValidator.js');
const bulkDeleteValidator = require('../../validation/bulkDeleteValidator.js');
const { deleteTransactionLogsBeforeValidator } = require('../../validation/transactionLogValidator.js');
const { handleHDBError, hdbErrors, ClientError } = require('../../utility/errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;

//Promisified functions
const pSearchByValue = search.searchByValue;
const pSearchSearchByHash = search.searchByHash;
const pInsert = insert.insert;
const pInsertUpdate = insert.update;

module.exports = {
	addJob,
	updateJob,
	handleGetJob,
	handleGetJobsByStartDate,
	getJobById,
};

async function handleGetJob(jsonBody) {
	if (jsonBody.id === undefined) throw new ClientError("'id' is required");
	let result = await getJobById(jsonBody.id);
	if (!hdbUtil.isEmptyOrZeroLength(result)) {
		result[0] = { ...result[0] };
		if (result[0].request !== undefined) delete result[0].request;
		delete result[0]['__createdtime__'];
		delete result[0]['__updatedtime__'];
	}

	return result;
}

async function handleGetJobsByStartDate(jsonBody) {
	try {
		let result = await getJobsInDateRange(jsonBody);
		log.trace(`Searching for jobs from ${jsonBody.from_date} to ${jsonBody.to_date}`);
		if (result && result.length > 0) {
			for (let currRes of result) {
				if (currRes.start_datetime) {
					currRes.start_datetime_converted = moment(currRes.start_datetime);
				}
				if (currRes.end_datetime) {
					currRes.end_datetime_converted = moment(currRes.end_datetime);
				}

				if (currRes.request !== undefined) delete currRes.request;
				delete currRes['__createdtime__'];
				delete currRes['__updatedtime__'];
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
 * @param jsonBody - job descriptor defined in the endpoint.
 * @returns {Promise<*>}
 */
async function addJob(jsonBody) {
	let result = { message: '', error: '', success: false, createdJob: undefined };
	if (!jsonBody || Object.keys(jsonBody).length === 0 || hdbUtil.isEmptyOrZeroLength(jsonBody.operation)) {
		let errMsg = `job parameter is invalid`;
		log.info(errMsg);
		result.error = errMsg;
		return result;
	}

	// Check for valid job type.
	if (!hdbTerms.JOB_TYPE_ENUM[jsonBody.operation]) {
		log.info(`invalid job type specified: ${jsonBody.operation}.`);
		return result;
	}

	// Validate csv operation to ensure that action is valid, schema and table exist, and if file load - check file.
	let operation = jsonBody.operation;
	let validationMsg;
	switch (operation) {
		case hdbTerms.OPERATIONS_ENUM.CSV_FILE_LOAD:
			validationMsg = fileLoadValidator.fileObject(jsonBody);
			break;
		case hdbTerms.OPERATIONS_ENUM.CSV_URL_LOAD:
			validationMsg = fileLoadValidator.urlObject(jsonBody);
			break;
		case hdbTerms.OPERATIONS_ENUM.CSV_DATA_LOAD:
			validationMsg = fileLoadValidator.dataObject(jsonBody);
			break;
		case hdbTerms.OPERATIONS_ENUM.IMPORT_FROM_S3:
			validationMsg = fileLoadValidator.s3FileObject(jsonBody);
			break;
		case hdbTerms.OPERATIONS_ENUM.DELETE_FILES_BEFORE:
		case hdbTerms.OPERATIONS_ENUM.DELETE_RECORDS_BEFORE:
			validationMsg = bulkDeleteValidator(jsonBody, 'date');
			break;
		case hdbTerms.OPERATIONS_ENUM.DELETE_AUDIT_LOGS_BEFORE:
			validationMsg = bulkDeleteValidator(jsonBody, 'timestamp');
			break;
		case hdbTerms.OPERATIONS_ENUM.DELETE_TRANSACTION_LOGS_BEFORE:
			validationMsg = deleteTransactionLogsBeforeValidator(jsonBody);
			break;
		case hdbTerms.OPERATIONS_ENUM.RESTART_SERVICE:
			if (hdbTerms.HDB_PROCESS_SERVICES[jsonBody.service] === undefined) {
				throw handleHDBError(new Error(), 'Invalid service', HTTP_STATUS_CODES.BAD_REQUEST, undefined, undefined, true);
			}
			break;
		default:
			break;
	}
	if (validationMsg) {
		throw handleHDBError(
			validationMsg,
			validationMsg.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	let newJob = new JobObject();
	newJob.type =
		jsonBody.operation === hdbTerms.OPERATIONS_ENUM.DELETE_RECORDS_BEFORE
			? hdbTerms.OPERATIONS_ENUM.DELETE_FILES_BEFORE
			: jsonBody.operation;
	newJob.type = jsonBody.operation;
	newJob.user = jsonBody.hdb_user?.username;
	let searchObj = new Search_Object(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME,
		'id',
		newJob.id,
		'id',
		['id']
	);

	let foundJob;
	try {
		foundJob = Array.from(await pSearchByValue(searchObj));
	} catch (e) {
		let message = `There was an error inserting a new job: ${e}`;
		log.error(message);
		return result;
	}
	//TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
	let foundValues = Array.isArray(foundJob) ? foundJob : Object.keys(foundJob);

	// It is highly unlikely that we will ever get into this, as a UUID duplicate is very rare.  Just in case we
	// do have a collision, we regenerate an ID and search again.  The odds of 2 collisions are so astronomically high
	// that we will just throw an error assuming there is bad input causing the issue.
	if (foundValues && foundValues.length > 0) {
		newJob.id = uuidV4();
		try {
			foundJob = await pSearchByValue(searchObj);
		} catch (e) {
			let message = `There was an error inserting a new job: ${e}`;
			log.error(message);
			return result;
		}
		//TODO: Once https://harperdb.atlassian.net/browse/HDB-501 is resolved, this check is no longer needed.
		foundValues = Array.isArray(foundJob) ? foundJob : Object.keys(foundJob);
		if (foundValues && foundValues.length > 0) {
			log.error('Error creating a job, could not find a unique job id.');
			return result;
		}
	}

	// We save the request so that the job process can get it and run the operation.
	// Sending the request via IPC to the job process was causing some messages to be lost under load.
	newJob.request = jsonBody;

	let insertObject = new Insert_Object(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, 'id', [
		newJob,
	]);
	let insertResult;
	try {
		insertResult = await pInsert(insertObject);
	} catch (e) {
		log.error(`There was an error inserting a job for job type: ${jsonBody.operation} -- ${e}`);
		result.success = false;
		return result;
	}

	if (insertResult.inserted_hashes.length === 0) {
		result.message = `Had a problem creating a job with type ${newJob.operation} and id ${newJob.id}`;
	} else {
		let resultMsg = `Created a job with type ${newJob.type} and id ${newJob.id}`;
		result.message = resultMsg;
		result.createdJob = newJob;
		result.success = true;
		log.trace(resultMsg);
	}
	return result;
}

/**
 * Get jobs in a range of dates by comparing start date of the job.
 * @param jsonBody - The inbound message
 * @returns {Promise<*>}
 */
async function getJobsInDateRange(jsonBody) {
	let parsedFromDate = moment(jsonBody.from_date, moment.ISO_8601);
	let parsedToDate = moment(jsonBody.to_date, moment.ISO_8601);

	if (!parsedFromDate.isValid()) {
		throw new Error(`Invalid 'from' date, must be in ISO-8601 format (YYYY-MM-DD).`);
	}
	if (!parsedToDate.isValid()) {
		throw new Error(`Invalid 'to' date, must be in ISO-8601 format (YYYY-MM-DD)`);
	}

	let jobSearchSql = `select * from system.hdb_job where start_datetime > '${parsedFromDate.valueOf()}' and start_datetime < '${parsedToDate.valueOf()}'`;
	let sqlSearchObj = new SQL_Search_Object(jobSearchSql, jsonBody.hdb_user);

	try {
		const hdbSql = require('../../sqlTranslator');
		const pSqlEvaluate = promisify(hdbSql.evaluateSQL);
		return await pSqlEvaluate(sqlSearchObj);
	} catch (e) {
		log.error(
			`there was a problem searching for jobs from date ${jsonBody.from_date} to date ${jsonBody.to_date} ${e}`
		);
		throw new Error(`there was an error searching for jobs.  Please check the log for details.`);
	}
}

/**
 * Get a job by a specific id
 * @param jsonBody - The inbound message
 * @returns {Promise<*>}
 */
async function getJobById(job_id) {
	if (hdbUtil.isEmptyOrZeroLength(job_id)) {
		return hdbUtil.errorizeMessage('Invalid job ID specified.');
	}

	const searchObj = new searchByHashObj(
		hdbTerms.SYSTEM_SCHEMA_NAME,
		hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME,
		[job_id],
		['*']
	);

	try {
		return await pSearchSearchByHash(searchObj);
	} catch (e) {
		let message = `There was an error searching for a job by id: ${job_id} ${e}`;
		log.error(message);
		return hdbUtil.errorizeMessage(`there was an error searching for jobs.  Please check the log for details.`);
	}
}

/**
 * Update the job record specified in the parameter.  If the status is COMPLETE or ERROR, the endDatetime field will be set to now().
 * @param jobObject - The object representing the desired record.
 * @returns {Promise<*>}
 */
async function updateJob(jobObject) {
	if (Object.keys(jobObject).length === 0) {
		throw new Error('invalid job object passed to updateJob');
	}
	if (hdbUtil.isEmptyOrZeroLength(jobObject.id)) {
		throw new Error('invalid ID passed to updateJob');
	}

	if (jobObject.status === hdbTerms.JOB_STATUS_ENUM.COMPLETE || jobObject.status === hdbTerms.JOB_STATUS_ENUM.ERROR) {
		jobObject.end_datetime = moment().valueOf();
	}

	let updateObject = new UpdateObject(hdbTerms.SYSTEM_SCHEMA_NAME, hdbTerms.SYSTEM_TABLE_NAMES.JOB_TABLE_NAME, [
		jobObject,
	]);
	let updateResult = undefined;
	updateResult = await pInsertUpdate(updateObject);
	return updateResult;
}
