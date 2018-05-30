'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const jobs = rewire('../../server/jobs');
const sinon = require('sinon');
const hdb_term = require('../../utility/hdbTerms');

const INSERT_RESULT = {
    'message': 'inserted 1 of 1 records',
    'inserted_hashes': [
        '2e358f82-523c-48b0-ab92-46ab52054419'
    ],
    'skipped_hashes': []
};

const JOB_SEARCH_RESULT =
{
    'user': 'eli',
    'type': 'EXPORT_TO_S3',
    'status': 'CREATED',
    'start_datetime': 1527638663991,
    'id': '2e358f82-523c-48b0-ab92-46ab52054419'
};

const DELETE_JOB_NOT_FOUND_RESULT = new Error("Item not found");

const ADD_JOB_SUCCESS =
{
    "message": "Created",
    "error": "",
    "success": true
}

describe('Test jobHandler', function() {
    let addJob_stub = undefined;
    let getJobsInDateRange_stub = undefined;
    let getJobById_stub = undefined;
    let deleteJobById_stub = undefined;

    let sandbox = null;
    beforeEach(function() {
        sandbox = sinon.sandbox.create();
    });
    afterEach(function() {
        sandbox.restore();
    });

    it('nominal case, call addJob.', function(done) {
        addJob_stub = sandbox.stub(jobs, "addJob").resolves(ADD_JOB_SUCCESS);
        jobs.__set__('addJob', addJob_stub);

        let test_request = {};
        test_request.operation = 'add_job';
        test_request.hdb_user = 'test user';

        try {
            jobs.jobHandler(test_request, function (err, result) {
            	if(err) {
            		throw (`expected success, got err ${err}`);
				}
                assert.equal(result.success, true, 'Got an error, expected success');
                done();
            });
        } catch(e) {
        	done(e);
		}
    });

    it('call addJob, throw an error to test catch.', function(done) {
        addJob_stub = sandbox.stub(jobs, "addJob").rejects(new Error('Oh Noes!'));
        jobs.__set__('addJob', addJob_stub);

        let test_request = {};
        test_request.operation = 'add_job';
        test_request.hdb_user = 'test user';

        try {
            jobs.jobHandler(test_request, function (err) {
                assert.ok(err.length > 0, 'Got success, expected an error.');
                done();
            });
        } catch(e) {
            done(e);
        }
    });

    it('nominal case, call getJobsInDateRange.', function(done) {
        getJobsInDateRange_stub = sandbox.stub().resolves([JOB_SEARCH_RESULT]);
        jobs.__set__('getJobsInDateRange', getJobsInDateRange_stub);

        let test_request = {};
        test_request.operation = 'search_jobs_by_start_date';
        test_request.hdb_user = 'test user';
        test_request.from_date = '2017-02-01';
        test_request.to_date = '2018-07-07';
        try {
            jobs.jobHandler(test_request, function (err, result) {
                if(err) {
                    throw (`expected success, got err ${err}`);
                }
                assert.equal(result.length, 1, 'Got an error, expected success');
                done();
            });
        } catch(e) {
            done(e);
        }
    });

    it('call getJobsInDateRange, throw an error to test catch.', function(done) {
        getJobsInDateRange_stub = sandbox.stub().rejects(new Error('Oh Noes!'));
        jobs.__set__('getJobsInDateRange', getJobsInDateRange_stub);

        let test_request = {};
        test_request.operation = 'search_jobs_by_start_date';
        test_request.hdb_user = 'test user';
        test_request.from_date = '2017-02-01';
        test_request.to_date = '2018-07-07';

        try {
            jobs.jobHandler(test_request, function (err) {
                assert.ok(err.length > 0, 'Got success, expected an error.');
                done();
            });
        } catch(e) {
            done(e);
        }
    });

    it('nominal case, call getJobById.', function(done) {
        getJobById_stub = sandbox.stub().resolves([JOB_SEARCH_RESULT]);
        jobs.__set__('getJobById', getJobById_stub);

        let test_request = {};
        test_request.operation = 'search_jobs_by_id';
        test_request.hdb_user = 'test user';
        test_request.id = null;
        try {
            jobs.jobHandler(test_request, function (err, result) {
                if(err) {
                    throw (`expected success, got err ${err}`);
                }
                assert.equal(result.length, 1, 'Got an error, expected success');
                done();
            });
        } catch(e) {
            done(e);
        }
    });

    it('call getJobById, throw an error to test catch.', function(done) {
        getJobById_stub = sandbox.stub().rejects(new Error('Oh Noes!'));
        jobs.__set__('getJobById', getJobById_stub);

        let test_request = {};
        test_request.operation = 'search_jobs_by_id';
        test_request.hdb_user = 'test user';
        test_request.id = null;
        try {
            jobs.jobHandler(test_request, function (err) {
                assert.ok(err.length > 0, 'Got success, expected an error.');
                done();
            });
        } catch(e) {
            done(e);
        }
    });

    it('nominal case, call deleteJobById.', function(done) {
        deleteJobById_stub = sandbox.stub().resolves({message: 'Succesfully deleted records'});
        jobs.__set__('deleteJobById', deleteJobById_stub);

        let test_request = {};
        test_request.operation = 'delete_job';
        test_request.hdb_user = 'test user';
        test_request.id = '2e358f82-523c-48b0-ab92-46ab52054419';
        try {
            jobs.jobHandler(test_request, function (err, result) {
                if(err) {
                    throw (`expected success, got err ${err}`);
                }
                assert.ok(result.message.length > 0, 'Got an error, expected success');
                done();
            });
        } catch(e) {
            done(e);
        }
    });

    it('call deleteJobById, throw an error to test catch.', function(done) {
        deleteJobById_stub = sandbox.stub().rejects(new Error('Oh Noes!'));
        jobs.__set__('deleteJobById', deleteJobById_stub);

        let test_request = {};
        test_request.operation = 'delete_job';
        test_request.hdb_user = 'test user';
        test_request.id = '2e358f82-523c-48b0-ab92-46ab52054419';
        try {
            jobs.jobHandler(test_request, function (err) {
                jobs.jobHandler(test_request, function (err) {
                    assert.ok(err.length > 0, 'Got success, expected an error.');
                    done();
                });
            });
        } catch(e) {
            done(e);
        }
    });
});

describe('Test addJob', function() {
    let search_stub = undefined;
    let insert_stub = undefined;
	let sandbox = null;
    let addJob = jobs.__get__('addJob');
	beforeEach(function() {
		sandbox = sinon.sandbox.create();
	});
	afterEach(function() {
		sandbox.restore();
	});

	it('nominal case, add a job to the schema.', test_util.mochaAsyncWrapper(async function() {
	    // we are not testing insert or search so stub them.
	   insert_stub = sandbox.stub().returns(INSERT_RESULT);
	   search_stub = sandbox.stub().returns([]);
	   jobs.__set__('p_search_by_value', search_stub);
	   jobs.__set__('p_insert', insert_stub);
	   let test_job = {};
	   test_job.job_type = hdb_term.JOB_TYPE_ENUM.CSV_FILE_UPLOAD;
	   test_job.hdb_user = 'test user';

	   let add_result = await addJob(test_job);
	   assert.ok(add_result.message.indexOf('Created a job') !== -1, 'Problem creating a job');
	}));
	it('test calling addJob, invalid job type, expect false.', test_util.mochaAsyncWrapper(async function() {
		insert_stub = sandbox.stub().returns(INSERT_RESULT);
		search_stub = sandbox.stub().returns([]);
		jobs.__set__('p_search_by_value', search_stub);
		jobs.__set__('p_insert', insert_stub);
		let test_job = {};
		test_job.job_type = 'bad type';
		test_job.hdb_user = 'test user';

		let add_result = await addJob(test_job);
		assert.equal(add_result.success, false);
	}));
	it('test calling addJob with first search id collision, expect true ', test_util.mochaAsyncWrapper(async function() {
		insert_stub = sandbox.stub().returns(INSERT_RESULT);
		search_stub = sandbox.stub().onFirstCall().returns({id: '12345'}).onSecondCall().returns([]);

		jobs.__set__('p_search_by_value', search_stub);
		jobs.__set__('p_insert', insert_stub);
		let test_job = {};
		test_job.job_type = hdb_term.JOB_TYPE_ENUM.CSV_FILE_UPLOAD;
		test_job.hdb_user = 'test user';

		let add_result = await addJob(test_job);
        assert.equal(add_result.success, true, 'Expected true success result');
	}));
	it('test calling addJob with 2 search id collisions, expect false.', test_util.mochaAsyncWrapper(async function() {
		insert_stub = sandbox.stub().returns(INSERT_RESULT);
		search_stub = sandbox.stub().onFirstCall().returns({id: '12345'}).onSecondCall().returns({id: '67890'});
		jobs.__set__('p_search_by_value', search_stub);
		jobs.__set__('p_insert', insert_stub);
		let test_job = {};
		test_job.job_type = hdb_term.JOB_TYPE_ENUM.CSV_FILE_UPLOAD;
		test_job.hdb_user = 'test user';

		let add_result = await addJob(test_job);
        assert.equal(add_result.success, false, 'Expected false result');
	}));
	it('test calling addJob with null job.', test_util.mochaAsyncWrapper(async function() {
		let test_job = null;

		let add_result = await addJob(test_job);
		assert.equal(add_result.success, false);
	}));
});

describe('Test getJobsInDateRange', function() {
    let sql_search_stub = undefined;
    let sandbox = null;
    let getJobsInDateRange = jobs.__get__('getJobsInDateRange');
    beforeEach(function() {
        sandbox = sinon.sandbox.create();
    });
    afterEach(function() {
        sandbox.restore();
    });
    it('nominal case, search in date ranges.', test_util.mochaAsyncWrapper(async function() {
        // we are not testing sql search so stub it.
        sql_search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
        jobs.__set__('p_sql_evaluate', sql_search_stub);
        let test_job = {};
        test_job.operation = 'search_jobs_by_start_date';
        test_job.hdb_user = 'test user';
        test_job.from_date = '2017-02-01';
        test_job.to_date = '2018-07-07';
        let search_result = await getJobsInDateRange(test_job);
        assert.equal(search_result.length, 1, 'expected 1 result returned');
    }));
    it('Search with invalid from date, expect error.', test_util.mochaAsyncWrapper(async function() {
        sql_search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
        jobs.__set__('p_sql_evaluate', sql_search_stub);
        let test_job = {};
        test_job.operation = 'search_jobs_by_start_date';
        test_job.hdb_user = 'test user';
        test_job.from_date = 'aaaaa';
        test_job.to_date = '2018-07-07';
        let search_result = await getJobsInDateRange(test_job);
        assert.ok(search_result.message.length > 0, 'expected error message');
    }));
    it('Search with invalid to date, expect error.', test_util.mochaAsyncWrapper(async function() {
        sql_search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
        jobs.__set__('p_sql_evaluate', sql_search_stub);
        let test_job = {};
        test_job.operation = 'search_jobs_by_start_date';
        test_job.hdb_user = 'test user';
        test_job.from_date = '2017-02-01';
        test_job.to_date = 'aaaaa';
        let search_result = await getJobsInDateRange(test_job);
        assert.ok(search_result.message.length > 0, 'expected error message');
    }));
    it('Search valid input, no results expected.', test_util.mochaAsyncWrapper(async function() {
        sql_search_stub = sandbox.stub().returns([]);
        jobs.__set__('p_sql_evaluate', sql_search_stub);
        let test_job = {};
        test_job.operation = 'search_jobs_by_start_date';
        test_job.hdb_user = 'test user';
        test_job.from_date = '2017-02-01';
        test_job.to_date = '2018-07-07';
        let search_result = await getJobsInDateRange(test_job);
        assert.equal(search_result.length, 0, 'expected no results');
    }));
});

describe('Test getJobById', function() {
    let search_stub = undefined;
    let sandbox = null;
    let getJobById = jobs.__get__('getJobById');
    beforeEach(function () {
        sandbox = sinon.sandbox.create();
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('nominal case, find 1 job by ID.', test_util.mochaAsyncWrapper(async function() {
        // we are not testing search so stub it.
        search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
        jobs.__set__('p_search_by_value', search_stub);

        let test_job = {};
        test_job.operation = 'search_jobs_by_id';
        test_job.hdb_user = 'test user';
        test_job.id = '2e358f82-523c-48b0-ab92-46ab52054419';

        let search_result = await getJobById(test_job);
        assert.equal(search_result.length, 1, 'Expected 1 result back');
    }));
    it('Search with null id, expect error', test_util.mochaAsyncWrapper(async function() {
        search_stub = sandbox.stub().returns([JOB_SEARCH_RESULT]);
        jobs.__set__('p_search_by_value', search_stub);

        let test_job = {};
        test_job.operation = 'search_jobs_by_id';
        test_job.hdb_user = 'test user';
        test_job.id = null;

        let search_result = await getJobById(test_job);
        assert.ok(search_result.message.length > 0, 'Expected error message');
    }));
});

describe('Test deleteJobById', function() {
    let delete_stub = undefined;
    let sandbox = null;
    let deleteJobById = jobs.__get__('deleteJobById');
    beforeEach(function () {
        sandbox = sinon.sandbox.create();
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('nominal case, delete 1 job by ID.', test_util.mochaAsyncWrapper(async function() {
        // we are not testing delete so stub it.
        delete_stub = sandbox.stub().returns('records successfully deleted');
        jobs.__set__('p_delete', delete_stub);

        let test_job = {};
        test_job.operation = 'delete_job';
        test_job.hdb_user = 'test user';
        test_job.id = '2e358f82-523c-48b0-ab92-46ab52054419';

        let delete_result = await deleteJobById(test_job);
        assert.ok(delete_result.message.length > 1, 'Expected 1 result back');
    }));
    it('Call delete with no job found', test_util.mochaAsyncWrapper(async function() {
        // we are not testing delete so stub it.
        delete_stub = sandbox.stub().throws(DELETE_JOB_NOT_FOUND_RESULT);
        jobs.__set__('p_delete', delete_stub);

        let test_job = {};
        test_job.operation = 'delete_job';
        test_job.hdb_user = 'test user';
        test_job.id = '2e358f82-523c-48b0-ab92-46ab52054419';

        let delete_result = await deleteJobById(test_job);
        assert.ok(delete_result.message.indexOf('not found') > 1, 'Expected 1 result back');
    }));
    it('Call delete with error thrown', test_util.mochaAsyncWrapper(async function() {
        // we are not testing delete so stub it.
        delete_stub = sandbox.stub().throws(new Error('blah blah'));
        jobs.__set__('p_delete', delete_stub);

        let test_job = {};
        test_job.operation = 'delete_job';
        test_job.hdb_user = 'test user';
        test_job.id = '2e358f82-523c-48b0-ab92-46ab52054419';

        let delete_result = await deleteJobById(test_job);
        assert.ok(delete_result.message.indexOf('not found') === -1, 'Expected 1 result back');
    }));
});