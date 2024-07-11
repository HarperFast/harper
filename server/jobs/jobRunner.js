'use strict';

const hdb_util = require('../../utility/common_utils');
const hdb_terms = require('../../utility/hdbTerms');
const moment = require('moment');
const bulk_load = require('../../dataLayer/bulkLoad');
const log = require('../../utility/logging/harper_logger');
const jobs = require('./jobs');
const hdb_export = require('../../dataLayer/export');
const hdb_delete = require('../../dataLayer/delete');
const threads_start = require('../threads/manageThreads');
const transaction_log = require('../../utility/logging/transactionLog');
const restart = require('../../bin/restart');
const { parentPort, isMainThread } = require('worker_threads');
const { onMessageByType } = require('../threads/manageThreads');

class RunnerMessage {
	constructor(job_object, message_json) {
		this.job = job_object;
		this.json = message_json;
	}
}

/**
 * Parses a RunnerMessage and runs the specified job.
 * @param runner_message
 * @throws Error
 */
async function parseMessage(runner_message) {
	if (!runner_message || Object.keys(runner_message).length === 0) {
		throw new Error('Empty runner passed to parseMessage');
	}
	if (!runner_message.json || Object.keys(runner_message.json).length === 0) {
		throw new Error('Empty JSON passed to parseMessage');
	}
	if (!runner_message.job || Object.keys(runner_message.job).length === 0) {
		throw new Error('Empty job passed to parseMessage');
	}
	if (hdb_util.isEmptyOrZeroLength(runner_message.json.operation)) {
		throw new Error('Invalid operation');
	}
	if (hdb_util.isEmptyOrZeroLength(runner_message.job.id)) {
		throw new Error('Empty job id specified');
	}

	switch (runner_message.json.operation) {
		case hdb_terms.JOB_TYPE_ENUM.csv_file_load:
			await runJob(runner_message, bulk_load.csvFileLoad);
			break;
		case hdb_terms.JOB_TYPE_ENUM.csv_url_load:
			await runJob(runner_message, bulk_load.csvURLLoad);
			break;
		case hdb_terms.JOB_TYPE_ENUM.csv_data_load:
			await runJob(runner_message, bulk_load.csvDataLoad);
			break;
		case hdb_terms.JOB_TYPE_ENUM.import_from_s3:
			await runJob(runner_message, bulk_load.importFromS3);
			break;
		case hdb_terms.JOB_TYPE_ENUM.empty_trash:
			break;
		case hdb_terms.JOB_TYPE_ENUM.export_local:
			await runJob(runner_message, hdb_export.export_local);
			break;
		case hdb_terms.JOB_TYPE_ENUM.export_to_s3:
			await runJob(runner_message, hdb_export.export_to_s3);
			break;
		case hdb_terms.JOB_TYPE_ENUM.delete_files_before:
		case hdb_terms.JOB_TYPE_ENUM.delete_records_before:
			await runJob(runner_message, hdb_delete.deleteFilesBefore);
			break;
		case hdb_terms.JOB_TYPE_ENUM.delete_audit_logs_before:
			await runJob(runner_message, hdb_delete.deleteAuditLogsBefore);
			break;
		case hdb_terms.JOB_TYPE_ENUM.delete_transaction_logs_before:
			await runJob(runner_message, transaction_log.deleteTransactionLogsBefore);
			break;
		case hdb_terms.JOB_TYPE_ENUM.restart_service:
			await runJob(runner_message, restart.restartService);
			return `Restarting ${runner_message.json.service}`;
			break;
		default:
			return `Invalid operation ${runner_message.json.operation} specified`;
	}
}

/**
 * Helper function to run the specified operation using the job update 'workflow'.
 * @param runner_message - The RunnerMessage created by the signal flow
 * @param operation - The operation to run.
 */
async function runJob(runner_message, operation) {
	try {
		runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.IN_PROGRESS;
		runner_message.job.start_datetime = moment().valueOf();
		// Update with "IN PROGRESS"
		await jobs.updateJob(runner_message.job);
		// Run the operation.
		await launchJobThread(runner_message.job.id);
	} catch (e) {
		let err_message = e.message !== undefined ? e.message : e;
		if (typeof err_message === 'string') {
			err_message = `There was an error running ${operation.name} job with id ${runner_message.job.id} - ${err_message}`;
			e.message = err_message;
		} else {
			//This ensures that the op/job id error is logged if the error message is passed as a non-string which will
			// be logged right after this below.  If the message is a string, everything will be logged below as the err_message
			log.error(`There was an error running ${operation.name} job with id ${runner_message.job.id}`);
		}
		log.error(err_message);
		runner_message.job.message = err_message;
		runner_message.job.status = hdb_terms.JOB_STATUS_ENUM.ERROR;
		try {
			// Update with "Error"
			await jobs.updateJob(runner_message.job);
		} catch (ex) {
			log.error(`Unable to update job with id ${runner_message.job.id}`);
			throw ex;
		}
		throw e;
	}
}

/**
 * Launches job in a separate process using processManagement
 * @param job_id
 * @returns {Promise<void>}
 */
async function launchJobThread(job_id) {
	log.trace('launching job thread:', job_id);
	if (isMainThread)
		threads_start.startWorker('server/jobs/jobProcess.js', {
			autoRestart: false,
			name: 'job',
			env: Object.assign({}, process.env, { [hdb_terms.PROCESS_NAME_ENV_PROP]: `JOB-${job_id}` }),
		});
	else
		parentPort.postMessage({
			type: hdb_terms.ITC_EVENT_TYPES.START_JOB,
			jobId: job_id,
		});
}
if (isMainThread) {
	onMessageByType(hdb_terms.ITC_EVENT_TYPES.START_JOB, async (message, port) => {
		try {
			threads_start.startWorker('server/jobs/jobProcess.js', {
				autoRestart: false,
				name: 'job',
				env: Object.assign({}, process.env, { [hdb_terms.PROCESS_NAME_ENV_PROP]: `JOB-${message.jobId}` }),
			});
		} catch (e) {
			log.error(e);
		}
	});
}

module.exports = {
	parseMessage: parseMessage,
	RunnerMessage: RunnerMessage,
};
