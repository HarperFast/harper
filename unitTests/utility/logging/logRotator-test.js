'use strict';

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const hdb_terms = require('../../../utility/hdbTerms');
const env_mgr = require('../../../utility/environment/environmentManager');
const hdb_utils = require('../../../utility/common_utils');
const hdb_logger = rewire('../../../utility/logging/harper_logger');
const log_rotator = rewire('../../../utility/logging/logRotator');

const LOG_DIR_NAME_TEST = 'testLogger';
const LOG_NAME_TEST = 'hdb.log';
const LOG_DIR_TEST = path.join(__dirname, LOG_DIR_NAME_TEST);
const LOG_FILE_PATH_TEST = path.join(LOG_DIR_TEST, LOG_NAME_TEST);
const TEST_TIMEOUT = 10000;
let test_file_size;

function callLogger() {
	hdb_logger.closeLogFile();
	for (let i = 1; i < 21; i++) {
		hdb_logger.error('This log is coming from the logRotator unit test. Log number:', i);
	}
	setTimeout(() => {}, 500);
	test_file_size = fs.statSync(LOG_FILE_PATH_TEST).size;
}

describe('Test logRotator module', () => {
	const sandbox = sinon.createSandbox();
	const log_notify_stub = sandbox.stub();
	const log_error_stub = sandbox.stub();

	before(() => {
		hdb_logger.__set__('log_to_stdstreams', false);
		hdb_logger.__set__('log_file_path', LOG_FILE_PATH_TEST);
		log_rotator.__set__('LOG_AUDIT_INTERVAL', 100);
		log_rotator.__set__('hdb_logger.getLogFilePath', sandbox.stub().returns(LOG_FILE_PATH_TEST));
		log_rotator.__set__('hdb_logger.notify', log_notify_stub);
		log_rotator.__set__('hdb_logger.error', log_error_stub);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_PATH, LOG_DIR_TEST);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROOT, LOG_DIR_TEST);
		fs.mkdirpSync(LOG_DIR_TEST);
	});

	afterEach(() => {
		sandbox.resetHistory();
		fs.emptyDirSync(LOG_DIR_TEST);
	});

	after(() => {
		sandbox.restore();
		rewire('../../../utility/logging/logRotator');
		try {
			fs.removeSync(LOG_DIR_TEST);
		} catch (e) {}
	});

	it('Test that log file is rotated if log has exceeded max size', async () => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE, '1K');
		callLogger();
		await log_rotator();
		await hdb_utils.asyncSetTimeout(300);
		const set_interval_id = log_rotator.__get__('set_interval_id');
		clearInterval(set_interval_id);
		const rotated_log_name = log_notify_stub.args[0][0].split(path.sep).pop();
		expect(test_file_size).to.equal(
			fs.statSync(path.join(LOG_DIR_TEST, rotated_log_name)).size,
			'Test log file should be the same size after it is rotated'
		);
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Expected to not find test log because rotate should have deleted it')
			.to.be.false;
	}).timeout(TEST_TIMEOUT);

	it('Test that log file is rotated if interval has exceeded its set value', async () => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE, undefined);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_INTERVAL, '1D');
		callLogger();
		const date_now_stub = sandbox.stub(Date, 'now').returns(1678001796297);
		await log_rotator();
		date_now_stub.restore();
		await hdb_utils.asyncSetTimeout(300);
		const set_interval_id = log_rotator.__get__('set_interval_id');
		clearInterval(set_interval_id);
		const rotated_log_name = log_notify_stub.args[0][0].split(path.sep).pop();
		expect(test_file_size).to.equal(
			fs.statSync(path.join(LOG_DIR_TEST, rotated_log_name)).size,
			'Test log file should be the same size after it is rotated'
		);
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Expected to not find test log because rotate should have deleted it')
			.to.be.false;
	}).timeout(TEST_TIMEOUT);

	it('Test log is compressed when rotated', async () => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE, '1K');
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_COMPRESS, true);
		callLogger();
		await log_rotator();
		await hdb_utils.asyncSetTimeout(300);
		const set_interval_id = log_rotator.__get__('set_interval_id');
		clearInterval(set_interval_id);
		const rotated_log_name = log_notify_stub.args[0][0].split(path.sep).pop();
		expect(fs.pathExistsSync(LOG_FILE_PATH_TEST), 'Expected to not find test log because rotate should have deleted it')
			.to.be.false;
		expect(fs.pathExistsSync(path.join(LOG_DIR_TEST, rotated_log_name))).to.be.true;
	});

	it('Test error logged if max size and interval not defined', async () => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE, undefined);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_INTERVAL, undefined);
		await log_rotator();
		expect(log_error_stub.args[0][0]).to.equal(
			"'interval' and 'maxSize' are both undefined, to enable logging rotation at least one of these values must be defined in harperdb-config.yaml"
		);
	});

	it('Test error logged if rotation path is undefined', async () => {
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_MAXSIZE, '1K');
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.LOGGING_ROTATION_PATH, undefined);
		await log_rotator();
		expect(log_error_stub.args[0][0]).to.equal(
			"'logging.rotation.path' is undefined, to enable logging rotation set this value in harperdb-config.yaml"
		);
	});
});
