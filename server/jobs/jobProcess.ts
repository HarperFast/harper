'use strict';

// Install the worker process guard first so user job code cannot terminate
// the worker via process.exit() or an unhandled rejection.
import { realExit } from '../threads/workerProcessGuard.ts';
import * as hdbTerms from '../../utility/hdbTerms.ts';
import * as hdbUtils from '../../utility/common_utils.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import * as globalSchema from '../../utility/globalSchema.ts';
import * as user from '../../security/user.ts';
import * as serverUtils from '../serverHelpers/serverUtilities.ts';
import moment from 'moment';
import * as jobs from './jobs.ts';
import { cloneDeep } from 'lodash';

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { getEnvBuiltInComponents } from './../../components/Application.ts';
import { PACKAGE_ROOT } from '../../utility/packageUtils.js';
const JOB_NAME = process.env[(hdbTerms as any).PROCESS_NAME_ENV_PROP] as string;
const JOB_ID = JOB_NAME.substring(4);

/**
 * Finds the appropriate function for the request and runs it.
 * Then updates the job table accordingly.
 * @returns {Promise<void>}
 */
(async function job() {
	// The request value could potentially be quite large so it's set to undefined to clear it out after being processed.
	let jobObj: any = { id: JOB_ID, request: undefined };
	let exitCode = 0;
	try {
		harperLogger.notify('Starting job:', JOB_ID);
		globalSchema.setSchemaDataToGlobal();
		await user.setUsersWithRolesCache();

		for (const { packageIdentifier } of getEnvBuiltInComponents()) {
			if (packageIdentifier.startsWith('@/')) {
				// for internal built-in components, we need to load the package in case it needs to register handlers
				await import(pathToFileURL(join(PACKAGE_ROOT, packageIdentifier.slice(1))).toString());
			}
		}

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
		// On Bun 1.3.13, calling process.exit() in a worker thread with lmdb-js loaded
		// while sibling workers are running causes a NAPI fatal error crash. Unref
		// parentPort (which broadcastWithAcknowledgement may have ref'd during schema
		// changes) so the event loop drains naturally without calling process.exit().
		parentPort?.unref();
		setTimeout(() => {
			realExit(exitCode);
		}, 3000).unref();
	}
})();
