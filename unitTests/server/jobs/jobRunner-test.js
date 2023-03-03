'use strict';

const test_util = require('../../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const jobs_runner = rewire('../../../server/jobs/jobRunner');
const jobs = require('../../../server/jobs/jobs');
const sinon = require('sinon');
const hdb_term = require('../../../utility/hdbTerms');
const bulk_load = require('../../../dataLayer/bulkLoad');
const JobObject = require('../../../server/jobs/JobObject');
const pm2_utils = require('../../../utility/pm2/utilityFunctions');
const threads_start = require('../../../server/threads/manageThreads');

const DATA_LOAD_MESSAGE = {
	operation: 'csv_data_load',
	schema: 'dev',
	table: 'breed',
	data: 'id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n',
};

const UPDATE_RESULT = {
	message: 'updated 1 of 1 records',
	update_hashes: ['de769a7b-64a3-4561-b92b-7893511f3596'],
	skipped_hashes: [],
};

const BULK_LOAD_RESPONSE = 'successfully loaded 3 records';

describe('Test parseMessage', function () {
	let update_stub = undefined;
	let bulk_load_stub = undefined;
	let parseMessage = jobs_runner.__get__('parseMessage');
	let sandbox = null;
	let start_stub;

	beforeEach(function () {
		sandbox = sinon.createSandbox();
		start_stub = sandbox.stub(threads_start, 'startWorker');
	});

	afterEach(function () {
		sandbox.restore();
		if (bulk_load_stub) {
			bulk_load_stub.restore();
		}
	});

	it(
		'Nominal case, parse with no errors',
		test_util.mochaAsyncWrapper(async function () {
			let runner_message = new jobs_runner.RunnerMessage();
			let job_object = new JobObject();
			runner_message.json = DATA_LOAD_MESSAGE;
			runner_message.job = job_object;

			update_stub = sandbox.stub(jobs, 'updateJob').returns(UPDATE_RESULT);

			await parseMessage(runner_message);
			assert.equal(start_stub.called, true, 'expected start called');
			assert.equal(
				runner_message.job.status,
				hdb_term.JOB_STATUS_ENUM.IN_PROGRESS,
				'Expected job status to be in progress.'
			);
		})
	);
	it('Invalid message json', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		let data_load_msg_temp = test_util.deepClone(DATA_LOAD_MESSAGE);
		data_load_msg_temp.operation = undefined;
		runner_message.json = data_load_msg_temp;
		runner_message.job = job_object;

		try {
			await parseMessage(runner_message);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid operation specified', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		let data_load_msg_temp = test_util.deepClone(DATA_LOAD_MESSAGE);
		data_load_msg_temp.operation = 'GoatBoy';
		runner_message.json = data_load_msg_temp;
		runner_message.job = job_object;

		try {
			let response = await parseMessage(runner_message);
			assert.ok(response.lastIndexOf('Invalid operation') >= 0, 'expected exception');
		} catch (e) {
			throw e;
		}
	});
	it('Invalid job id', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		job_object.id = null;
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = job_object;

		try {
			await parseMessage(runner_message);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid job', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = undefined;

		try {
			await parseMessage(runner_message);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid json', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		runner_message.json = null;
		runner_message.job = job_object;

		try {
			await parseMessage(runner_message);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid runner message', async function () {
		let runner_message = {};
		try {
			await parseMessage(runner_message);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});

	it('Test the operation switch statement', async () => {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = job_object;
		const run_csv_response_test = 'run csv called';
		const run_job_stub = sandbox.stub().resolves(run_csv_response_test);
		jobs_runner.__set__('runJob', run_job_stub);

		runner_message.json.operation = 'csv_file_load';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'csvFileLoad');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'csv_url_load';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'csvURLLoad');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'csv_data_load';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'csvDataLoad');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'import_from_s3';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'importFromS3');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'export_local';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'export_local');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'export_to_s3';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'export_to_s3');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'delete_files_before';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'deleteFilesBefore');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'delete_records_before';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'deleteFilesBefore');

		run_job_stub.resetHistory();
		runner_message.json.operation = 'delete_audit_logs_before';
		await parseMessage(runner_message);
		assert.equal(run_job_stub.args[0][1].name, 'deleteAuditLogsBefore');
	});
});

describe('Test runJob', function () {
	let sandbox = sinon.createSandbox();
	let update_stub = undefined;
	let bulk_load_stub = undefined;
	let launch_job_process_stub = sandbox.stub();
	let launch_job_thread_rw;
	let runJob = jobs_runner.__get__('runJob');

	before(() => {
		launch_job_thread_rw = jobs_runner.__set__('launchJobThread', launch_job_process_stub);
	});

	after(() => {
		launch_job_thread_rw();
	});

	beforeEach(function () {
		sandbox = sinon.createSandbox();
	});

	afterEach(function () {
		sandbox.restore();
	});

	it('Nominal case, run stubbed dataload', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = job_object;

		update_stub = sandbox.stub(jobs, 'updateJob').returns(UPDATE_RESULT);

		await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		assert(update_stub.called);
		assert(launch_job_process_stub.called);
	});

	it('Throw exception during update to test error handling', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = job_object;

		update_stub = sandbox
			.stub(jobs, 'updateJob')
			.onFirstCall()
			.throws(new Error('BAD UPDATE'))
			.onSecondCall()
			.returns(UPDATE_RESULT);
		bulk_load_stub = sandbox.stub(bulk_load, 'csvDataLoad').returns(BULK_LOAD_RESPONSE);

		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
			assert.equal(runner_message.job.status, hdb_term.JOB_STATUS_ENUM.ERROR, 'Expected job status to be complete.');
			assert.ok(runner_message.job.message.length > 0, 'Expected job status to be complete.');
		}
	});
	it('Invalid message json', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		let data_load_msg_temp = test_util.deepClone(DATA_LOAD_MESSAGE);
		data_load_msg_temp.operation = undefined;
		runner_message.json = data_load_msg_temp;
		runner_message.job = job_object;

		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid job id', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		job_object.id = null;
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = job_object;

		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid job', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = undefined;

		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid json', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		runner_message.json = null;
		runner_message.job = job_object;

		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Invalid runner message', async function () {
		let runner_message = {};
		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
		}
	});
	it('Throw exception during csv data load', async function () {
		let runner_message = new jobs_runner.RunnerMessage();
		let job_object = new JobObject();
		runner_message.json = DATA_LOAD_MESSAGE;
		runner_message.job = job_object;

		update_stub = sandbox.stub(jobs, 'updateJob').returns(UPDATE_RESULT);
		bulk_load_stub = sandbox.stub(bulk_load, 'csvDataLoad').throws(new Error('bad csv load oh noes!'));

		try {
			await runJob(runner_message, bulk_load.csvDataLoad, runner_message.json);
		} catch (e) {
			assert.ok(e.message.length > 0, 'expected exception');
			assert.ok(runner_message.job.end_datetime !== undefined, 'Expected end date time to be set');
			assert.equal(runner_message.job.status, hdb_term.JOB_STATUS_ENUM.ERROR, 'Expected job status to be complete.');
			assert.ok(runner_message.job.message.length > 0, 'Expected job status to be complete.');
		}
	});
});
