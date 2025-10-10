'use strict';

const hdbTerms = require('../../utility/hdbTerms.ts');
const hdbUtils = require('../../utility/common_utils.js');
const harperLogger = require('../../utility/logging/harper_logger.js');
const globalSchema = require('../../utility/globalSchema.js');
const user = require('../../security/user.js');
const serverUtils = require('../serverHelpers/serverUtilities.ts');
const moment = require('moment');
const jobs = require('./jobs.js');
const { cloneDeep } = require('lodash');
const JOB_NAME = process.env[hdbTerms.PROCESS_NAME_ENV_PROP];
const JOB_ID = JOB_NAME.substring(4);

/**
 * Finds the appropriate function for the request and runs it.
 * Then updates the job table accordingly.
 * @returns {Promise<void>}
 */
(async function job() {
	// The request value could potentially be quite large so it's set to undefined to clear it out after being processed.
	let jobObj = { id: JOB_ID, request: undefined };
	let exitCode = 0;
	try {
		harperLogger.notify('Starting job:', JOB_ID);
		globalSchema.setSchemaDataToGlobal();
		await user.setUsersWithRolesCache();

		// When the job record is first inserted in hdbJob table by HDB, the incoming API request is included, this is
		// how we pass the request to the job process. IPC was initially used but messages were getting lost under heavy load.
		const jobRecord = await jobs.getJobById(JOB_ID);
		if (hdbUtils.isEmptyOrZeroLength(jobRecord)) {
			throw new Error(`Unable to find a record in hdbJob for job: ${JOB_ID}`);
		}

		let { request } = jobRecord[0];
		if (hdbUtils.isEmptyOrZeroLength(request)) {
			throw new Error('Did not find job request in hdb_job table, unable to proceed');
		}
		request = cloneDeep(request);

		const operation = serverUtils.getOperationFunction(request);
		harperLogger.trace('Running operation:', request.operation, 'for job', JOB_ID);

		// Run the job operation.
		const results = await operation.job_operation_function(request);
		harperLogger.trace('Result from job:', JOB_ID, results);

		jobObj.status = hdbTerms.JOB_STATUS_ENUM.COMPLETE;
		if (typeof results === 'string') jobObj.message = results;
		else {
			jobObj.result = results;
			jobObj.message = 'Successfully completed job: ' + JOB_ID;
		}
		jobObj.end_datetime = moment().valueOf();
		harperLogger.notify('Successfully completed job:', JOB_ID);
	} catch (err) {
		exitCode = 1;
		harperLogger.error(err);
		jobObj.status = hdbTerms.JOB_STATUS_ENUM.ERROR;
		jobObj.message = err.message ? err.message : err;
		jobObj.end_datetime = moment().valueOf();
	} finally {
		await jobs.updateJob(jobObj);
		setTimeout(() => {
			process.exit(exitCode);
		}, 3000).unref();
	}
})();
