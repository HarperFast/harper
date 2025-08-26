'use strict';

const hdbUtil = require('../../utility/common_utils.js');
const hdbTerms = require('../../utility/hdbTerms.ts');
const moment = require('moment');
const bulkLoad = require('../../dataLayer/bulkLoad.js');
const log = require('../../utility/logging/harper_logger.js');
const jobs = require('./jobs.js');
const hdbExport = require('../../dataLayer/export.js');
const hdbDelete = require('../../dataLayer/delete.js');
const threadsStart = require('../threads/manageThreads.js');
const transactionLog = require('../../utility/logging/transactionLog.js');
const restart = require('../../bin/restart.js');
const { parentPort, isMainThread } = require('worker_threads');
const { onMessageByType } = require('../threads/manageThreads.js');

class RunnerMessage {
	constructor(jobObject, messageJson) {
		this.job = jobObject;
		this.json = messageJson;
	}
}

/**
 * Parses a RunnerMessage and runs the specified job.
 * @param runnerMessage
 * @throws Error
 */
async function parseMessage(runnerMessage) {
	if (!runnerMessage || Object.keys(runnerMessage).length === 0) {
		throw new Error('Empty runner passed to parseMessage');
	}
	if (!runnerMessage.json || Object.keys(runnerMessage.json).length === 0) {
		throw new Error('Empty JSON passed to parseMessage');
	}
	if (!runnerMessage.job || Object.keys(runnerMessage.job).length === 0) {
		throw new Error('Empty job passed to parseMessage');
	}
	if (hdbUtil.isEmptyOrZeroLength(runnerMessage.json.operation)) {
		throw new Error('Invalid operation');
	}
	if (hdbUtil.isEmptyOrZeroLength(runnerMessage.job.id)) {
		throw new Error('Empty job id specified');
	}

	switch (runnerMessage.json.operation) {
		case hdbTerms.JOB_TYPE_ENUM.csv_file_load:
			await runJob(runnerMessage, bulkLoad.csvFileLoad);
			break;
		case hdbTerms.JOB_TYPE_ENUM.csv_url_load:
			await runJob(runnerMessage, bulkLoad.csvURLLoad);
			break;
		case hdbTerms.JOB_TYPE_ENUM.csv_data_load:
			await runJob(runnerMessage, bulkLoad.csvDataLoad);
			break;
		case hdbTerms.JOB_TYPE_ENUM.import_from_s3:
			await runJob(runnerMessage, bulkLoad.importFromS3);
			break;
		case hdbTerms.JOB_TYPE_ENUM.empty_trash:
			break;
		case hdbTerms.JOB_TYPE_ENUM.export_local:
			await runJob(runnerMessage, hdbExport.export_local);
			break;
		case hdbTerms.JOB_TYPE_ENUM.export_to_s3:
			await runJob(runnerMessage, hdbExport.export_to_s3);
			break;
		case hdbTerms.JOB_TYPE_ENUM.delete_files_before:
		case hdbTerms.JOB_TYPE_ENUM.delete_records_before:
			await runJob(runnerMessage, hdbDelete.deleteFilesBefore);
			break;
		case hdbTerms.JOB_TYPE_ENUM.delete_audit_logs_before:
			await runJob(runnerMessage, hdbDelete.deleteAuditLogsBefore);
			break;
		case hdbTerms.JOB_TYPE_ENUM.delete_transaction_logs_before:
			await runJob(runnerMessage, transactionLog.deleteTransactionLogsBefore);
			break;
		case hdbTerms.JOB_TYPE_ENUM.restart_service:
			await runJob(runnerMessage, restart.restartService);
			return `Restarting ${runnerMessage.json.service}`;
			break;
		default:
			return `Invalid operation ${runnerMessage.json.operation} specified`;
	}
}

/**
 * Helper function to run the specified operation using the job update 'workflow'.
 * @param runnerMessage - The RunnerMessage created by the signal flow
 * @param operation - The operation to run.
 */
async function runJob(runnerMessage, operation) {
	try {
		runnerMessage.job.status = hdbTerms.JOB_STATUS_ENUM.IN_PROGRESS;
		runnerMessage.job.start_datetime = moment().valueOf();
		// Update with "IN PROGRESS"
		await jobs.updateJob(runnerMessage.job);
		// Run the operation.
		await launchJobThread(runnerMessage.job.id);
	} catch (e) {
		let errMessage = e.message !== undefined ? e.message : e;
		if (typeof errMessage === 'string') {
			errMessage = `There was an error running ${operation.name} job with id ${runnerMessage.job.id} - ${errMessage}`;
			e.message = errMessage;
		} else {
			//This ensures that the op/job id error is logged if the error message is passed as a non-string which will
			// be logged right after this below.  If the message is a string, everything will be logged below as the errMessage
			log.error(`There was an error running ${operation.name} job with id ${runnerMessage.job.id}`);
		}
		log.error(errMessage);
		runnerMessage.job.message = errMessage;
		runnerMessage.job.status = hdbTerms.JOB_STATUS_ENUM.ERROR;
		try {
			// Update with "Error"
			await jobs.updateJob(runnerMessage.job);
		} catch (ex) {
			log.error(`Unable to update job with id ${runnerMessage.job.id}`);
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
		threadsStart.startWorker('server/jobs/jobProcess.js', {
			autoRestart: false,
			name: 'job',
			env: { ...process.env, [hdbTerms.PROCESS_NAME_ENV_PROP]: `JOB-${job_id}` },
		});
	else
		parentPort.postMessage({
			type: hdbTerms.ITC_EVENT_TYPES.START_JOB,
			jobId: job_id,
		});
}
if (isMainThread) {
	onMessageByType(hdbTerms.ITC_EVENT_TYPES.START_JOB, async (message, port) => {
		try {
			threadsStart.startWorker('server/jobs/jobProcess.js', {
				autoRestart: false,
				name: 'job',
				env: { ...process.env, [hdbTerms.PROCESS_NAME_ENV_PROP]: `JOB-${message.jobId}` },
			});
		} catch (e) {
			log.error(e);
		}
	});
}

module.exports = {
	parseMessage,
	RunnerMessage,
};
