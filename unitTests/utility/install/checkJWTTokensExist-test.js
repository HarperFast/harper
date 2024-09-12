'use strict';

const test_util = require('../../test_utils');
test_util.preTestPrep();
const fs = require('fs-extra');
const path = require('path');
const logger = require('../../../utility/logging/harper_logger');
const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');
const check_jwt_token_exist = rewire('../../../utility/install/checkJWTTokensExist');

const KEYS_PATH = path.join(test_util.getMockTestPath(), 'keys');

describe('test checkJWTTokenExist function', () => {
	let fs_access_spy;
	let fs_writefile_spy;
	let logger_error_spy;

	before(() => {
		test_util.getMockTestPath();
		fs_access_spy = sandbox.spy(fs, 'accessSync');
		fs_writefile_spy = sandbox.spy(fs, 'writeFileSync');
		logger_error_spy = sandbox.spy(logger, 'error');
	});

	after(() => {
		sandbox.restore();
	});

	beforeEach(() => {
		fs.mkdirpSync(KEYS_PATH);
		fs_access_spy.resetHistory();
		fs_writefile_spy.resetHistory();
		logger_error_spy.resetHistory();
	});

	afterEach(() => {
		fs.removeSync(test_util.getMockTestPath());

		fs_access_spy.resetHistory();
		fs_writefile_spy.resetHistory();
		logger_error_spy.resetHistory();
	});

	it('test happy path', () => {
		check_jwt_token_exist();

		assert(logger_error_spy.callCount === 0);

		assert(fs_access_spy.callCount === 1);
		assert(fs_access_spy.threw() === true);
		assert(fs_access_spy.firstCall.args[0] === path.join(KEYS_PATH, '.jwtPass'));
		assert(fs_access_spy.firstCall.exception.code === 'ENOENT');

		assert(fs_writefile_spy.callCount === 3);
		assert(fs_writefile_spy.threw() === false);
		assert(fs_writefile_spy.firstCall.args[0] === path.join(KEYS_PATH, '.jwtPass'));
		assert(fs_writefile_spy.firstCall.exception === undefined);
		assert(fs_writefile_spy.secondCall.args[0] === path.join(KEYS_PATH, '.jwtPrivate.key'));
		assert(fs_writefile_spy.secondCall.exception === undefined);
		assert(fs_writefile_spy.thirdCall.args[0] === path.join(KEYS_PATH, '.jwtPublic.key'));
		assert(fs_writefile_spy.thirdCall.exception === undefined);

		let passphrase = fs.readFileSync(path.join(KEYS_PATH, '.jwtPass'));
		let private_key = fs.readFileSync(path.join(KEYS_PATH, '.jwtPrivate.key'));
		let public_key = fs.readFileSync(path.join(KEYS_PATH, '.jwtPublic.key'));

		assert(passphrase !== undefined);
		assert(private_key.toString().startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'));
		assert(public_key.toString().startsWith('-----BEGIN PUBLIC KEY-----'));
	});

	it('test keys exist', () => {
		fs.writeFileSync(path.join(KEYS_PATH, '.jwtPass'), '');
		fs.writeFileSync(path.join(KEYS_PATH, '.jwtPrivate.key'), '');
		fs.writeFileSync(path.join(KEYS_PATH, '.jwtPublic.key'), '');

		fs_writefile_spy.resetHistory();
		check_jwt_token_exist();

		assert(logger_error_spy.callCount === 0);
		assert(fs_access_spy.callCount === 3);
		assert(fs_access_spy.threw() === false);
		assert(fs_access_spy.firstCall.args[0] === path.join(KEYS_PATH, '.jwtPass'));
		assert(fs_access_spy.secondCall.args[0] === path.join(KEYS_PATH, '.jwtPrivate.key'));
		assert(fs_access_spy.thirdCall.args[0] === path.join(KEYS_PATH, '.jwtPublic.key'));

		assert(fs_writefile_spy.callCount === 0);
	});
});
