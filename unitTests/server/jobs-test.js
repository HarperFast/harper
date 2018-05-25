"use strict";

const test_util = require('../test_utils');
test_util.preTestPrep();

const job_obj = require('../../server/JobObject');
const assert = require('assert');
const rewire = require('rewire');
const jobs = rewire('../../server/jobs');
const sinon = require('sinon');
const search = require('../../data_layer/search');
const hdb_term = require('../../utility/hdbTerms');
const {promisify} = require('util');

let p_search_by_value = promisify(search.searchByValue);

describe('Test addJob', function() {
    let search_stub = undefined;
    let insert_stub = undefined;
    let sandbox = null;
    describe('Test addJob', function() {
	it('nominal case, add a job to the schema.', test_util.mochaAsyncWrapper(async function() {
	    // we are not testing insert or search so stub them.
	   insert_stub = sandbox.stub().returns(true);
	   search_stub = sandbox.stub().returns([]);
	   jobs.__set__("p_search_by_value", search_stub);
	   jobs.__set__("p_insert", insert_stub);
	   let test_job = {};
	   test_job.job_type = hdb_term.JOB_TYPE_ENUM.CSV_FILE_UPLOAD;
	   test_job.hdb_user = 'test user';

	   let add_result = await jobs.addJob(test_job);
	   assert.equal(add_result, true);
	}));
	it('test calling addJob, invalid job type, expect false.', test_util.mochaAsyncWrapper(async function() {
		// we are not testing insert or search so stub them.
		insert_stub = sandbox.stub().returns(true);
		search_stub = sandbox.stub().returns([]);
		jobs.__set__("p_search_by_value", search_stub);
		jobs.__set__("p_insert", insert_stub);
		let test_job = {};
		test_job.job_type = 'bad type';
		test_job.hdb_user = 'test user';

		let add_result = await jobs.addJob(test_job);
		assert.equal(add_result, false);
	}));
	it('test calling addJob with first search id collision, expect true ', test_util.mochaAsyncWrapper(async function() {
		// we are not testing insert or search so stub them.
		insert_stub = sandbox.stub().returns(true);
		search_stub = sandbox.stub().onFirstCall().returns({id: '12345'}).onSecondCall().returns([]);
		jobs.__set__("p_search_by_value", search_stub);
		jobs.__set__("p_insert", insert_stub);
		let test_job = {};
		test_job.job_type = hdb_term.JOB_TYPE_ENUM.CSV_FILE_UPLOAD;
		test_job.hdb_user = 'test user';

		let add_result = await jobs.addJob(test_job);
		assert.equal(add_result, true);
	}));
	it('test calling addJob with 2 search id collisions, expect false.', test_util.mochaAsyncWrapper(async function() {
		// we are not testing insert or search so stub them.
		insert_stub = sandbox.stub().returns(true);
		search_stub = sandbox.stub().onFirstCall().returns({id: '12345'}).onSecondCall().returns({id: '67890'});
		jobs.__set__("p_search_by_value", search_stub);
		jobs.__set__("p_insert", insert_stub);
		let test_job = {};
		test_job.job_type = hdb_term.JOB_TYPE_ENUM.CSV_FILE_UPLOAD;
		test_job.hdb_user = 'test user';

		let add_result = await jobs.addJob(test_job);
		assert.equal(add_result, false);
	}));
	it('test calling addJob with null job.', test_util.mochaAsyncWrapper(async function() {
		let test_job = null;

		let add_result = await jobs.addJob(test_job);
		assert.equal(add_result, false);
	}));
});
