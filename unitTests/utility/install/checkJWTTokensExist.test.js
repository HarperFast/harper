'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();
const fs = require('fs-extra');
const path = require('path');
const logger = require('#src/utility/logging/harper_logger');
const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const rewire = require('rewire');
const check_jwt_token_exist = rewire('#js/utility/install/checkJWTTokensExist');

let keysPath;

describe('test checkJWTTokenExist function', () => {
	let fs_access_spy;
	let fs_writefile_spy;
	let logger_error_spy;

	before(() => {
		const testPath = testUtils.getMockTestPath();
		keysPath = path.join(testPath, 'keys');
		fs_access_spy = sandbox.spy(fs, 'accessSync');
		fs_writefile_spy = sandbox.spy(fs, 'writeFileSync');
		logger_error_spy = sandbox.spy(logger, 'error');
	});

	after(() => {
		sandbox.restore();
	});

	beforeEach(() => {
		fs.mkdirpSync(keysPath);
		fs_access_spy.resetHistory();
		fs_writefile_spy.resetHistory();
		logger_error_spy.resetHistory();
	});

	afterEach(() => {
		fs.removeSync(keysPath);

		fs_access_spy.resetHistory();
		fs_writefile_spy.resetHistory();
		logger_error_spy.resetHistory();
	});

	it('test happy path', () => {
		check_jwt_token_exist();

		assert(logger_error_spy.callCount === 0);

		assert(fs_access_spy.callCount === 1);
		assert(fs_access_spy.threw() === true);
		assert(fs_access_spy.firstCall.args[0] === path.join(keysPath, '.jwtPass'));
		assert(fs_access_spy.firstCall.exception.code === 'ENOENT');

		assert(fs_writefile_spy.callCount === 3);
		assert(fs_writefile_spy.threw() === false);
		assert(fs_writefile_spy.firstCall.args[0] === path.join(keysPath, '.jwtPass'));
		assert(fs_writefile_spy.firstCall.exception === undefined);
		assert(fs_writefile_spy.secondCall.args[0] === path.join(keysPath, '.jwtPrivate.key'));
		assert(fs_writefile_spy.secondCall.exception === undefined);
		assert(fs_writefile_spy.thirdCall.args[0] === path.join(keysPath, '.jwtPublic.key'));
		assert(fs_writefile_spy.thirdCall.exception === undefined);

		let passphrase = fs.readFileSync(path.join(keysPath, '.jwtPass'));
		let private_key = fs.readFileSync(path.join(keysPath, '.jwtPrivate.key'));
		let public_key = fs.readFileSync(path.join(keysPath, '.jwtPublic.key'));

		assert(passphrase !== undefined);
		assert(private_key.toString().startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'));
		assert(public_key.toString().startsWith('-----BEGIN PUBLIC KEY-----'));
	});

	it('test keys exist', () => {
		fs.writeFileSync(path.join(keysPath, '.jwtPass'), '');
		fs.writeFileSync(path.join(keysPath, '.jwtPrivate.key'), '');
		fs.writeFileSync(path.join(keysPath, '.jwtPublic.key'), '');

		fs_writefile_spy.resetHistory();
		check_jwt_token_exist();

		assert(logger_error_spy.callCount === 0);
		assert(fs_access_spy.callCount === 3);
		assert(fs_access_spy.threw() === false);
		assert(fs_access_spy.firstCall.args[0] === path.join(keysPath, '.jwtPass'));
		assert(fs_access_spy.secondCall.args[0] === path.join(keysPath, '.jwtPrivate.key'));
		assert(fs_access_spy.thirdCall.args[0] === path.join(keysPath, '.jwtPublic.key'));

		assert(fs_writefile_spy.callCount === 0);
	});
});
