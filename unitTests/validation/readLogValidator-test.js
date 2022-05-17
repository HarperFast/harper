'use strict';

const env_mangr = require('../../utility/environment/environmentManager');
const chai = require('chai');
const { expect } = chai;
const read_log_validator = require('../../validation/readLogValidator');
const hdb_terms = require('../../utility/hdbTerms');
const path = require('path');
const fs = require('fs-extra');
const sinon = require('sinon');

const LOG_DIR_TEST = 'testLogger';
const TEST_LOG_DIR = path.join(__dirname, LOG_DIR_TEST);

describe('Test readLogValidator module', () => {
	const sandbox = sinon.createSandbox();

	afterEach(() => {
		sandbox.restore();
	});

	it('Test happy path validation returns undefined', () => {
		env_mangr.setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, TEST_LOG_DIR);

		sandbox.stub(fs, 'existsSync').returns(true);

		const test_read_log_object = {
			operation: 'read_log',
			from: '2022-01-06T01:01:01.000Z',
			until: '2022-02-06T01:01:01.000Z',
			level: 'error',
			order: 'asc',
			limit: 3,
			start: 0,
			log_name: 'hdb.log',
		};

		const result = read_log_validator(test_read_log_object);
		expect(result).to.be.undefined;
	});

	it('Test from datetime invalid returned', () => {
		const test_read_log_object = {
			operation: 'read_log',
			from: 'pancake',
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'from' date 'pancake' is invalid.");
	});

	it('Test until datetime invalid returned', () => {
		const test_read_log_object = {
			operation: 'read_log',
			until: null,
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'until' date 'null' is invalid.");
	});

	it('Test level invalid returned', () => {
		const test_read_log_object = {
			operation: 'read_log',
			level: 'waffle',
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'level' must be one of [notify, fatal, error, warn, info, debug, trace]");
	});

	it('Test order invalid returned', () => {
		const test_read_log_object = {
			operation: 'read_log',
			order: 'descending',
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'order' must be one of [asc, desc]");
	});

	it('Test limit invalid returned', () => {
		const test_read_log_object = {
			operation: 'read_log',
			limit: 0,
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'limit' must be greater than or equal to 1");
	});

	it('Test start invalid returned', () => {
		const test_read_log_object = {
			operation: 'read_log',
			start: -1,
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'start' must be greater than or equal to 0");
	});

	it('Test log_name invalid returned', () => {
		env_mangr.setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, TEST_LOG_DIR);

		const test_read_log_object = {
			operation: 'read_log',
			log_name: 'hashbrown.log',
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'log_name' 'hashbrown.log' is invalid.");
	});

	it("Test log_name doesn't exist returned", () => {
		env_mangr.setProperty(hdb_terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY, TEST_LOG_DIR);

		const test_read_log_object = {
			operation: 'read_log',
			log_name: 'clustering_connector.log',
		};

		const result = read_log_validator(test_read_log_object);
		expect(result.message).to.equal("'log_name' 'clustering_connector.log' is invalid.");
	});
});
