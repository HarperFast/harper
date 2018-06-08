'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const jobs_runner = rewire('../../server/jobRunner');
const jobs = require('../../server/jobs');
const sinon = require('sinon');
const hdb_term = require('../../utility/hdbTerms');
const csv_bulk_load = require('../../data_layer/csvBulkLoad');
const JobObject = require('../../server/JobObject');

const DATA_LOAD_MESSAGE = {
    "operation":"csv_data_load",
    "schema":"dev",
    "table":"breed",
    "data":"id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n"
};

const UPDATE_RESULT = {
    "message": "updated 1 of 1 records",
    "update_hashes": [
        "de769a7b-64a3-4561-b92b-7893511f3596"
    ],
    "skipped_hashes": []
};

const BULK_LOAD_RESPONSE = 'successfully loaded 3 records';

describe('Test parseMessage', function() {
    let update_stub = undefined;
    let bulk_load_stub = undefined;
    let parseMessage = jobs_runner.__get__('parseMessage');
    let sandbox = null;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('Nominal case, parse with no errors', test_util.mochaAsyncWrapper(async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = job_object;

        update_stub = sandbox.stub(jobs, "updateJob").returns(UPDATE_RESULT);
        bulk_load_stub = sandbox.stub(csv_bulk_load, "csvDataLoad").returns(BULK_LOAD_RESPONSE);

        let result = await parseMessage(runner_message);
        assert.equal(result.success, true, 'expected success');
        assert.ok(runner_message.job.end_datetime !== undefined, 'Expected end date time to be set');
        assert.equal(runner_message.job.status, hdb_term.JOB_STATUS_ENUM.COMPLETE, 'Expected job status to be complete.');
        assert.ok(runner_message.job.message.length > 0, 'Expected job status to be complete.');
    }));
    it('Invalid message json', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        let data_load_msg_temp = test_util.deepClone(DATA_LOAD_MESSAGE);
        data_load_msg_temp.operation = undefined;
        runner_message.json = data_load_msg_temp;
        runner_message.job = job_object;

        try {
            await parseMessage(runner_message);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Invalid job id', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        job_object.id = null;
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = job_object;

        try {
            await parseMessage(runner_message);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Invalid job', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = undefined;

        try {
            await parseMessage(runner_message);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Invalid json', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        runner_message.json = null;
        runner_message.job = job_object;

        try {
            await parseMessage(runner_message);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
});

describe('Test runCSVJob', function() {
    let sandbox = null;
    let update_stub = undefined;
    let bulk_load_stub = undefined;
    let runCSVJob = jobs_runner.__get__('runCSVJob');
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('Nominal case, run stubbed dataload', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = job_object;

        update_stub = sandbox.stub(jobs, "updateJob").returns(UPDATE_RESULT);
        bulk_load_stub = sandbox.stub(csv_bulk_load, "csvDataLoad").returns(BULK_LOAD_RESPONSE);

        let result = await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        assert.equal(result.success, true, 'expected success');
        assert.ok(runner_message.job.end_datetime !== undefined, 'Expected end date time to be set');
        assert.equal(runner_message.job.status, hdb_term.JOB_STATUS_ENUM.COMPLETE, 'Expected job status to be complete.');
        assert.ok(runner_message.job.message.length > 0, 'Expected job status to be complete.');
    });
    it('Throw exception during update to test error handling', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = job_object;

        update_stub = sandbox.stub(jobs, "updateJob").onFirstCall().throws(new Error("BAD UPDATE")).onSecondCall().returns(UPDATE_RESULT);
        bulk_load_stub = sandbox.stub(csv_bulk_load, "csvDataLoad").returns(BULK_LOAD_RESPONSE);

        try {
            await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
            assert.ok(runner_message.job.end_datetime !== undefined, 'Expected end date time to be set');
            assert.equal(runner_message.job.status, hdb_term.JOB_STATUS_ENUM.ERROR, 'Expected job status to be complete.');
            assert.ok(runner_message.job.message.length > 0, 'Expected job status to be complete.');
        }
    });
    it('Invalid message json', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        let data_load_msg_temp = test_util.deepClone(DATA_LOAD_MESSAGE);
        data_load_msg_temp.operation = undefined;
        runner_message.json = data_load_msg_temp;
        runner_message.job = job_object;

        try {
            await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Invalid job id', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        job_object.id = null;
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = job_object;

        try {
            await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Invalid job', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = undefined;

        try {
            await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Invalid json', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        runner_message.json = null;
        runner_message.job = job_object;

        try {
            await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
        }
    });
    it('Throw exception during csv data load', async function() {
        let runner_message = new jobs_runner.RunnerMessage();
        let job_object = new JobObject();
        runner_message.json = DATA_LOAD_MESSAGE;
        runner_message.job = job_object;

        update_stub = sandbox.stub(jobs, "updateJob").returns(UPDATE_RESULT);
        bulk_load_stub = sandbox.stub(csv_bulk_load, "csvDataLoad").throws(new Error('bad csv load oh noes!'));

        try {
            await runCSVJob(runner_message, csv_bulk_load.csvDataLoad, runner_message.json);
        } catch(e) {
            assert.ok(e.message.length > 0, 'expected exception');
            assert.ok(runner_message.job.end_datetime !== undefined, 'Expected end date time to be set');
            assert.equal(runner_message.job.status, hdb_term.JOB_STATUS_ENUM.ERROR, 'Expected job status to be complete.');
            assert.ok(runner_message.job.message.length > 0, 'Expected job status to be complete.');
        }
    });
});