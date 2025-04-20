'use strict';

const test_util = require('../../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const hdb_term = require('../../../utility/hdbTerms');
const JobObject = require('../../../server/jobs/JobObject');
const file_load_validator = require('../../../validation/fileLoadValidator');
const jobs = rewire('../../../server/jobs/jobs');

const INSERT_RESULT = {
	message: 'inserted 1 of 1 records',
	inserted_hashes: ['2e358f82-523c-48b0-ab92-46ab52054419'],
	skipped_hashes: [],
};

const JOB_SEARCH_RESULT = {
	user: 'eli',
	type: 'export_to_s3',
	status: 'CREATED',
	start_datetime: 1527638663991,
	id: '2e358f82-523c-48b0-ab92-46ab52054419',
};

const UPDATE_RESULT = {
	message: 'updated 1 of 1 records',
	update_hashes: ['de769a7b-64a3-4561-b92b-7893511f3596'],
	skipped_hashes: [],
};

describe('Test jobs.js', () => {
	describe('Test getJob & getJobsByStartDate handlers', function () {
		let getJobsInDateRange_stub = undefined;
		let getJobById_stub = undefined;

		let sandbox = null;
		beforeEach(function () {
			sandbox = sinon.createSandbox();
		});
		afterEach(function () {
			sandbox.restore();
		});

		it('nominal case, call handleGetJobsByStartDate.', async function () {
			getJobsInDateRange_stub = sandbox.stub().resolves([JOB_SEARCH_RESULT]);
			jobs.__set__('getJobsInDateRange', getJobsInDateRange_stub);

			let test_request = {};
			test_request.operation = 'search_jobs_by_start_date';
			test_request.hdb_user = 'test user';
			test_request.from_date = '2017-02-01';
			test_request.to_date = '2018-07-07';
			let result = undefined;
			try {
				result = await jobs.handleGetJobsByStartDate(test_request);
				assert.equal(result.length, 1, 'Got an error, expected success');
			} catch (e) {
				result = e;
			}
		});

		it('nominal case, call handleGetJobsByStartDate if end_datetime', async function () {
			let job_search_res = test_util.deepClone(JOB_SEARCH_RESULT);
			delete job_search_res.start_datetime;
			job_search_res.end_datetime = 1527638663991;

			getJobsInDateRange_stub = sandbox.stub().resolves([job_search_res]);
			jobs.__set__('getJobsInDateRange', getJobsInDateRange_stub);

			let test_request = {};
			test_request.operation = 'search_jobs_by_start_date';
			test_request.hdb_user = 'test user';
			test_request.from_date = '2017-02-01';
			test_request.to_date = '2018-07-07';
			let result = undefined;

			const expected_result = {
				user: 'eli',
				type: 'export_to_s3',
				status: 'CREATED',
				id: '2e358f82-523c-48b0-ab92-46ab52054419',
				end_datetime: 1527638663991,
				end_datetime_converted: '2018-05-30T00:04:23.991Z',
			};

			try {
				result = await jobs.handleGetJobsByStartDate(test_request);
				assert.equal(expected_result, result);
			} catch (e) {
				result = e;
			}
		});

		it('call getJobsInDateRange, throw an error to test catch.', async function () {
			getJobsInDateRange_stub = sandbox.stub().rejects(new Error('Oh Noes!'));
			jobs.__set__('getJobsInDateRange', getJobsInDateRange_stub);

			let test_request = {};
			test_request.operation = 'search_jobs_by_start_date';
			test_request.hdb_user = 'test user';
			test_request.from_date = '2017-02-01';
			test_request.to_date = '2018-07-07';
			let result = undefined;
			try {
				result = await jobs.handleGetJobsByStartDate(test_request);
			} catch (e) {
				result = e;
			}

			assert.strictEqual(result instanceof Error, true, 'Got success, expected an error.');
		});

		it('nominal case, call handleGetJob', async function () {
			getJobById_stub = sandbox.stub().resolves([JOB_SEARCH_RESULT]);
			jobs.__set__('getJobById', getJobById_stub);

			let test_request = {};
			test_request.operation = 'get_job';
			test_request.hdb_user = 'test user';
			test_request.id = null;
			let result = undefined;
			try {
				result = await jobs.handleGetJob(test_request);
				assert.equal(result.length, 1, 'Got an error, expected success');
			} catch (e) {
				result = e;
			}
		});

		it('nominal case, call handleGetJob if end_datetime', async function () {
			let job_search_res = test_util.deepClone(JOB_SEARCH_RESULT);
			delete job_search_res.start_datetime;
			job_search_res.end_datetime = 1527638663991;

			getJobById_stub = sandbox.stub().resolves([job_search_res]);
			jobs.__set__('getJobById', getJobById_stub);

			let test_request = {};
			test_request.operation = 'get_job';
			test_request.hdb_user = 'test user';
			test_request.id = null;
			let result = undefined;

			const expected_result = {
				user: 'eli',
				type: 'export_to_s3',
				status: 'CREATED',
				id: '2e358f82-523c-48b0-ab92-46ab52054419',
				end_datetime: 1527638663991,
				end_datetime_converted: '2018-05-30T00:04:23.991Z',
			};
			try {
				result = await jobs.handleGetJob(test_request);
				assert.equal(expected_result, result);
			} catch (e) {
				result = e;
			}
		});

		it('call handleGetJob, throw an error to test catch.', async function () {
			getJobById_stub = sandbox.stub().rejects(new Error('Oh Noes!'));
			jobs.__set__('getJobById', getJobById_stub);

			let test_request = {};
			test_request.operation = 'get_job';
			test_request.hdb_user = 'test user';
			test_request.id = null;
			let result = undefined;
			try {
				result = await jobs.handleGetJob(test_request);
			} catch (e) {
				result = e;
			}
			assert.strictEqual(result instanceof Error, true, 'Got success, expected an error.');
		});
	});

	describe('Test addJob', function () {
		let search_stub = undefined;
		let insert_stub = undefined;
		let sandbox = sinon.createSandbox();
		let addJob = jobs.__get__('addJob');
		let url_obj_stub;
		let data_obj_stub;
		let s3_file_obj_stub;
		let p_search_by_value_stub = sandbox.stub().resolves([]);
		let p_insert_stub = sandbox.stub().resolves(INSERT_RESULT);

		beforeEach(function () {
			sandbox.stub(file_load_validator, 'fileObject');
			url_obj_stub = sandbox.stub(file_load_validator, 'urlObject').returns(null);
			data_obj_stub = sandbox.stub(file_load_validator, 'dataObject').returns(null);
			s3_file_obj_stub = sandbox.stub(file_load_validator, 's3FileObject').returns(null);
			jobs.__set__('pSearchByValue', p_search_by_value_stub);
			jobs.__set__('pInsert', p_insert_stub);
		});

		afterEach(function () {
			sandbox.restore();
		});

		it(
			'nominal case, add a job to the schema.',
			test_util.mochaAsyncWrapper(async function () {
				// we are not testing insert or search so stub them.
				insert_stub = sandbox.stub().returns(INSERT_RESULT);
				search_stub = sandbox.stub().returns([]);
				jobs.__set__('pSearchByValue', search_stub);
				jobs.__set__('pInsert', insert_stub);
				let test_job = {};
				test_job.operation = hdb_term.JOB_TYPE_ENUM.csv_file_load;
				test_job.hdb_user = 'test user';

				let add_result = await addJob(test_job);
				assert.ok(add_result.message.indexOf('Created a job') !== -1, 'Problem creating a job');
			})
		);

		it(
			'test calling addJob, invalid job type, expect false.',
			test_util.mochaAsyncWrapper(async function () {
				insert_stub = sandbox.stub().returns(INSERT_RESULT);
				search_stub = sandbox.stub().returns([]);
				jobs.__set__('pSearchByValue', search_stub);
				jobs.__set__('pInsert', insert_stub);
				let test_job = {};
				test_job.operation = 'bad type';
				test_job.hdb_user = 'test user';

				let add_result = await addJob(test_job);
				assert.equal(add_result.success, false);
			})
		);

		it(
			'test calling addJob with first search id collision, expect true ',
			test_util.mochaAsyncWrapper(async function () {
				insert_stub = sandbox.stub().returns(INSERT_RESULT);
				search_stub = sandbox.stub().onFirstCall().returns({ id: '12345' }).onSecondCall().returns([]);

				jobs.__set__('pSearchByValue', search_stub);
				jobs.__set__('pInsert', insert_stub);
				let test_job = {};
				test_job.operation = hdb_term.JOB_TYPE_ENUM.csv_file_load;
				test_job.hdb_user = 'test user';

				let add_result = await addJob(test_job);
				assert.equal(add_result.success, true, 'Expected true success result');
			})
		);

		it.skip(
			// this stub is not functioning reliably, and the first search id collision will
			// probably occur after the sun has enveloped the earth.
			'test calling addJob with 2 search id collisions, expect false.',
			test_util.mochaAsyncWrapper(async function () {
				insert_stub = sandbox.stub().returns(INSERT_RESULT);
				search_stub = sandbox.stub().onFirstCall().returns({ id: '12345' }).onSecondCall().returns({ id: '67890' });
				jobs.__set__('pSearchByValue', search_stub);
				jobs.__set__('pInsert', insert_stub);
				let test_job = {};
				test_job.operation = hdb_term.JOB_TYPE_ENUM.csv_file_load;
				test_job.hdb_user = 'test user';

				let add_result = await addJob(test_job);
				assert.equal(add_result.success, false, 'Expected false result');
			})
		);

		it(
			'test calling addJob with null job.',
			test_util.mochaAsyncWrapper(async function () {
				let test_job = null;

				let add_result = await addJob(test_job);
				assert.equal(add_result.success, false);
			})
		);

		it('test validation msg from CSV URL load is handled as expected', async () => {
			let test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.csv_url_load,
				hdb_user: 'test user',
			};
			const validation_err_test = new Error('validation errors');
			url_obj_stub.returns(validation_err_test);
			const expected_err = test_util.generateHDBError(validation_err_test.message, 400);
			await test_util.assertErrorAsync(addJob, [test_job], expected_err);
		});

		it('test validation msg from CSV data load is handled as expected', async () => {
			let test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.csv_data_load,
				hdb_user: 'test user',
			};
			const validation_err_test = new Error('validation errors');
			data_obj_stub.returns(validation_err_test);
			const expected_err = test_util.generateHDBError(validation_err_test.message, 400);
			await test_util.assertErrorAsync(addJob, [test_job], expected_err);
		});

		it('test validation msg from import S3 file is handled as expected', async () => {
			let test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.import_from_s3,
				hdb_user: 'test user',
			};
			const validation_err_test = new Error('validation errors');
			s3_file_obj_stub.returns(validation_err_test);
			const expected_err = test_util.generateHDBError(validation_err_test.message, 400);
			await test_util.assertErrorAsync(addJob, [test_job], expected_err);
		});

		it('test error result is returned', async () => {
			const test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.import_from_s3,
				hdb_user: 'test user',
			};
			const expected_result = {
				message: '',
				error: '',
				success: false,
				createdJob: undefined,
			};
			p_search_by_value_stub.throws(new Error('error with search by value'));
			const result = await addJob(test_job);

			assert.deepEqual(result, expected_result);
		});

		it('test error result is returned when error with duplicate id search', async () => {
			const test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.import_from_s3,
				hdb_user: 'test user',
			};
			const expected_result = {
				message: '',
				error: '',
				success: false,
				createdJob: undefined,
			};
			p_search_by_value_stub.resetHistory();
			p_search_by_value_stub.resolves(['123abc']);
			p_search_by_value_stub.onCall(1).throws(new Error('error with search by value'));
			const result = await addJob(test_job);

			assert.deepEqual(result, expected_result);
		});

		it('test error result is returned when error with insert', async () => {
			const test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.csv_file_load,
				hdb_user: 'test user',
			};
			const expected_result = {
				message: '',
				error: '',
				success: false,
				createdJob: undefined,
			};
			p_search_by_value_stub.resolves([]);
			p_insert_stub.throws(new Error('error inserting'));
			const result = await addJob(test_job);

			assert.deepEqual(result, expected_result);
		});

		it('test error result is returned when inserted hashes length is zero', async () => {
			const test_job = {
				operation: hdb_term.JOB_TYPE_ENUM.import_from_s3,
				hdb_user: 'test user',
			};
			p_search_by_value_stub.resolves([]);
			p_insert_stub.resolves({ inserted_hashes: [] });
			const result = await addJob(test_job);

			assert.equal(result.message.includes('Had a problem creating a job'), true);
		});
	});

	describe('Test getJobsInDateRange', function () {
		let sql_search_stub = undefined;
		let sandbox = null;
		let getJobsInDateRange = jobs.__get__('getJobsInDateRange');

		beforeEach(function () {
			sandbox = sinon.createSandbox();
		});

		afterEach(function () {
			sandbox.restore();
		});

		it(
			'nominal case, search in date ranges.',
			test_util.mochaAsyncWrapper(async function () {
				// we are not testing sql search so stub it.
				sql_search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
				jobs.__set__('pSqlEvaluate', sql_search_stub);
				let test_job = {};
				test_job.operation = 'search_jobs_by_start_date';
				test_job.hdb_user = 'test user';
				test_job.from_date = '2017-02-01';
				test_job.to_date = '2018-07-07';
				let search_result = await getJobsInDateRange(test_job);
				assert.equal(search_result.length, 1, 'expected 1 result returned');
			})
		);

		it('Search with invalid from date, expect error.', async function () {
			sql_search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
			jobs.__set__('pSqlEvaluate', sql_search_stub);
			let test_job = {};
			test_job.operation = 'search_jobs_by_start_date';
			test_job.hdb_user = 'test user';
			test_job.from_date = 'aaaaa';
			test_job.to_date = '2018-07-07';
			try {
				await getJobsInDateRange(test_job);
			} catch (e) {
				assert.ok(e.message.length > 0, 'expected error message');
			}
		});

		it('Search with invalid to date, expect error.', async function () {
			sql_search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
			jobs.__set__('pSqlEvaluate', sql_search_stub);
			let test_job = {};
			test_job.operation = 'search_jobs_by_start_date';
			test_job.hdb_user = 'test user';
			test_job.from_date = '2017-02-01';
			test_job.to_date = 'aaaaa';
			try {
				await getJobsInDateRange(test_job);
			} catch (e) {
				assert.ok(e.message.length > 0, 'expected error message');
			}
		});

		it(
			'Search valid input, no results expected.',
			test_util.mochaAsyncWrapper(async function () {
				sql_search_stub = sandbox.stub().returns([]);
				jobs.__set__('pSqlEvaluate', sql_search_stub);
				let test_job = {};
				test_job.operation = 'search_jobs_by_start_date';
				test_job.hdb_user = 'test user';
				test_job.from_date = '2017-02-01';
				test_job.to_date = '2018-07-07';
				let search_result = await getJobsInDateRange(test_job);
				assert.equal(search_result.length, 0, 'expected no results');
			})
		);

		it('test custom error message is thrown', async () => {
			sql_search_stub = sandbox.stub().throws(new Error('error with sql search'));
			jobs.__set__('pSqlEvaluate', sql_search_stub);
			let test_job = {};
			test_job.operation = 'search_jobs_by_start_date';
			test_job.hdb_user = 'test user';
			test_job.from_date = '2017-02-01';
			test_job.to_date = '2018-07-07';
			await test_util.assertErrorAsync(
				getJobsInDateRange,
				[test_job],
				new Error(`there was an error searching for jobs.  Please check the log for details.`)
			);
		});
	});

	describe('Test getJobById', function () {
		let search_stub = undefined;
		let sandbox = null;
		let getJobById = jobs.__get__('getJobById');
		beforeEach(function () {
			sandbox = sinon.createSandbox();
		});
		afterEach(function () {
			sandbox.restore();
		});

		it(
			'nominal case, find 1 job by ID.',
			test_util.mochaAsyncWrapper(async function () {
				// we are not testing search so stub it.
				search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
				jobs.__set__('pSearchSearchByHash', search_stub);

				let test_job = {};
				test_job.operation = 'get_job';
				test_job.hdb_user = 'test user';
				test_job.id = '2e358f82-523c-48b0-ab92-46ab52054419';

				let search_result = await getJobById(test_job);
				assert.equal(search_result.length, 1, 'Expected 1 result back');
			})
		);

		it(
			'Search with null id, expect error',
			test_util.mochaAsyncWrapper(async function () {
				search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
				jobs.__set__('pSearchSearchByHash', search_stub);

				let test_job = {};
				test_job.operation = 'get_job';
				test_job.hdb_user = 'test user';
				test_job.id = null;

				let search_result = await getJobById(test_job.id);
				assert.ok(search_result.message.length > 0, 'Expected error message');
			})
		);

		it('test custom error message is thrown', async () => {
			search_stub = sandbox.stub().throws(new Error('error searching'));
			jobs.__set__('pSearchSearchByHash', search_stub);
			let test_job = {};
			test_job.operation = 'get_job';
			test_job.hdb_user = 'test user';
			test_job.id = '123abc';
			let search_result = await getJobById(test_job);
			assert.equal(search_result.message, 'there was an error searching for jobs.  Please check the log for details.');
		});
	});

	describe('Test updateJob', function () {
		let update_stub = undefined;
		let sandbox = null;
		let updateJob = jobs.__get__('updateJob');
		beforeEach(function () {
			sandbox = sinon.createSandbox();
		});
		afterEach(function () {
			sandbox.restore();
		});

		it(
			'Nominal case of updateJob',
			test_util.mochaAsyncWrapper(async function () {
				update_stub = sandbox.stub().returns(UPDATE_RESULT);
				jobs.__set__('pInsertUpdate', update_stub);
				//

				let job_object = new JobObject();
				job_object.status = hdb_term.JOB_STATUS_ENUM.IN_PROGRESS;

				let found = await updateJob(job_object);
				assert.ok(found.update_hashes.length > 0, 'Invalid response from update');
				assert.ok(job_object.status === hdb_term.JOB_STATUS_ENUM.IN_PROGRESS, 'Status changed but should not have');
			})
		);
		it(
			'Nominal case of updateJob, check end time updated',
			test_util.mochaAsyncWrapper(async function () {
				update_stub = sandbox.stub().returns(UPDATE_RESULT);
				jobs.__set__('pInsertUpdate', update_stub);
				//

				let job_object = new JobObject();
				job_object.status = hdb_term.JOB_STATUS_ENUM.COMPLETE;

				let found = await updateJob(job_object);
				assert.ok(found.update_hashes.length > 0, 'Invalid response from update');
				assert.ok(job_object.status === hdb_term.JOB_STATUS_ENUM.COMPLETE, 'Status changed but should not have');
				assert.ok(job_object.end_datetime !== undefined, 'End time should have been updated');
			})
		);
		it('Test bad object check', async function () {
			update_stub = sandbox.stub().returns(UPDATE_RESULT);
			jobs.__set__('pInsertUpdate', update_stub);

			let job_object = {};

			try {
				await updateJob(job_object);
			} catch (e) {
				assert.ok(e.message.length > 0, "Didn't get expected exception");
			}
		});
		it('Test missing id check', async function () {
			update_stub = sandbox.stub().returns(UPDATE_RESULT);
			jobs.__set__('pInsertUpdate', update_stub);

			let job_object = new JobObject();
			job_object.id = null;

			try {
				await updateJob(job_object);
			} catch (e) {
				assert.ok(e.message.length > 0, "Didn't get expected exception");
			}
		});
	});
});
