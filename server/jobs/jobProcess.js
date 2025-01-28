'use strict';

require('../../bin/dev');
const hdb_terms = require('../../utility/hdbTerms');
const hdb_utils = require('../../utility/common_utils');
const harper_logger = require('../../utility/logging/harper_logger');
const global_schema = require('../../utility/globalSchema');
const user = require('../../security/user');
const server_utils = require('../serverHelpers/serverUtilities');
const { start: startNATS } = require('../nats/natsReplicator');
const { closeConnection } = require('../nats/utility/natsUtils');
const moment = require('moment');
const jobs = require('./jobs');
const { cloneDeep } = require('lodash');
const JOB_NAME = process.env[hdb_terms.PROCESS_NAME_ENV_PROP];
const JOB_ID = JOB_NAME.substring(4);

/**
 * Finds the appropriate function for the request and runs it.
 * Then updates the job table accordingly.
 * @returns {Promise<void>}
 */
(async function job() {
	// The request value could potentially be quite large so it's set to undefined to clear it out after being processed.
	let job_obj = { id: JOB_ID, request: undefined };
	let exit_code = 0;
	try {
		harper_logger.notify('Starting job:', JOB_ID);
		startNATS();
		global_schema.setSchemaDataToGlobal();
		await user.setUsersWithRolesCache();

		// When the job record is first inserted in hdb_job table by HDB, the incoming API request is included, this is
		// how we pass the request to the job process. IPC was initially used but messages were getting lost under heavy load.
		const job_record = await jobs.getJobById(JOB_ID);
		if (hdb_utils.isEmptyOrZeroLength(job_record)) {
			throw new Error(`Unable to find a record in hdb_job for job: ${JOB_ID}`);
		}

		let { request } = job_record[0];
		if (hdb_utils.isEmptyOrZeroLength(request)) {
			throw new Error('Did not find job request in hdb_job table, unable to proceed');
		}
		request = cloneDeep(request);

		const operation = server_utils.getOperationFunction(request);
		harper_logger.trace('Running operation:', request.operation, 'for job', JOB_ID);

		// Run the job operation.
		const results = await operation.job_operation_function(request);
		harper_logger.trace('Result from job:', JOB_ID, results);

		job_obj.status = hdb_terms.JOB_STATUS_ENUM.COMPLETE;
		if (typeof results === 'string') job_obj.message = results;
		else {
			job_obj.result = results;
			job_obj.message = 'Successfully completed job: ' + JOB_ID;
		}
		job_obj.end_datetime = moment().valueOf();
		harper_logger.notify('Successfully completed job:', JOB_ID);
	} catch (err) {
		exit_code = 1;
		harper_logger.error(err);
		job_obj.status = hdb_terms.JOB_STATUS_ENUM.ERROR;
		job_obj.message = err.message ? err.message : err;
		job_obj.end_datetime = moment().valueOf();
	} finally {
		await jobs.updateJob(job_obj);
		await closeConnection();
		setTimeout(() => {
			process.exit(exit_code);
		}, 3000).unref();
	}
})();
