'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const chai = require('chai');
const { expect } = chai;

const rewire = require('rewire');
let upgrade_rw;

const hdbInfoController = require('../../dataLayer/hdbInfoController');
const updatePrompt = require('../../upgrade/upgradePrompt');
const directivesManager = require('../../upgrade/directivesManager');
const chalk = require('chalk');
const { packageJson } = require('../../utility/packageUtils');
const { UpgradeObject } = require('../../upgrade/UpgradeObjects');
const fs = require('fs-extra');
const ps_list = require('../../utility/psList');

const TEST_CURR_VERS = '3.0.0';
const TEST_DATA_VERS = '2.9.9';
const TEST_UPGRADE_OBJ = new UpgradeObject(TEST_DATA_VERS, TEST_CURR_VERS);

describe('Test upgrade.js', () => {
	let sandbox = sinon.createSandbox();
	let consoleLog_stub;
	let processExit_stub;
	let printToLogAndConsole_stub;
	let getVersionUpdateInfo_stub;
	let version_stub;
	let forceUpdatePrompt_stub;
	const log_notify_stub = sandbox.stub().callsFake(() => {});
	const log_error_stub = sandbox.stub().callsFake(() => {});
	const log_info_stub = sandbox.stub().callsFake(() => {});
	const logger_fake = {
		notify: log_notify_stub,
		error: log_error_stub,
		info: log_info_stub,
	};
	let log_rw;

	before(() => {
		upgrade_rw = rewire(`../../bin/upgrade`);
		log_rw = upgrade_rw.__set__('hdbLogger', logger_fake);
		consoleLog_stub = sandbox.stub(console, 'log').returns();
		printToLogAndConsole_stub = sandbox.stub().returns();
		upgrade_rw.__set__('printToLogAndConsole', printToLogAndConsole_stub);
		processExit_stub = sandbox.stub(process, 'exit');
		version_stub = sandbox.stub(packageJson, 'version').get(() => TEST_CURR_VERS);
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
		rewire(`../../bin/upgrade`);
	});

	describe.skip('upgrade()', async () => {
		const create_log_file_stub = sandbox.stub();
		let runUpgrade_orig;
		let runUpgrade_stub;
		let checkIfRunning_stub;
		let fsExistsSync_stub;

		before(() => {
			runUpgrade_orig = upgrade_rw.__get__('runUpgrade');
			runUpgrade_stub = sandbox.stub().resolves();
			upgrade_rw.__set__('hdbLogger.createLogFile', create_log_file_stub);
			upgrade_rw.__set__('runUpgrade', runUpgrade_stub);
			checkIfRunning_stub = sandbox.stub().resolves();
			upgrade_rw.__set__('checkIfRunning', checkIfRunning_stub);
			getVersionUpdateInfo_stub = sandbox.stub(hdbInfoController, 'getVersionUpdateInfo').resolves(TEST_UPGRADE_OBJ);
			forceUpdatePrompt_stub = sandbox.stub(updatePrompt, 'forceUpdatePrompt').resolves(true);
			fsExistsSync_stub = sandbox.stub(fs, 'existsSync').returns(true);
		});

		beforeEach(() => {
			processExit_stub.throws('This is the only way to stub an end to the call stack');
		});

		afterEach(() => {
			getVersionUpdateInfo_stub.resolves(TEST_UPGRADE_OBJ);
			version_stub.returns(TEST_CURR_VERS);
			forceUpdatePrompt_stub.resolves(true);
			processExit_stub.reset();
			sandbox.resetHistory();
		});

		after(() => {
			upgrade_rw.__set__('runUpgrade', runUpgrade_orig);
			fsExistsSync_stub.reset();
		});

		it('Nominal case - upgrade runs to completion w/o update obj passed in as arg', async () => {
			await upgrade_rw.upgrade();

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.true;
			expect(checkIfRunning_stub.calledOnce).to.be.true;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.true;
			expect(forceUpdatePrompt_stub.args[0][0]).to.deep.equal(TEST_UPGRADE_OBJ);
			expect(runUpgrade_stub.calledOnce).to.be.true;
			expect(runUpgrade_stub.args[0][0]).to.deep.equal(TEST_UPGRADE_OBJ);
			expect(printToLogAndConsole_stub.args[1][0]).to.equal(
				`HarperDB was successfully upgraded to version ${TEST_CURR_VERS}`
			);
		});

		it('Nominal case - upgrade runs to completion w update obj passed in as arg', async () => {
			await upgrade_rw.upgrade(TEST_UPGRADE_OBJ);

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.false;
			expect(checkIfRunning_stub.calledOnce).to.be.true;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.true;
			expect(forceUpdatePrompt_stub.args[0][0]).to.deep.equal(TEST_UPGRADE_OBJ);
			expect(runUpgrade_stub.calledOnce).to.be.true;
			expect(runUpgrade_stub.args[0][0]).to.deep.equal(TEST_UPGRADE_OBJ);
			expect(printToLogAndConsole_stub.args[1][0]).to.equal(
				`HarperDB was successfully upgraded to version ${TEST_CURR_VERS}`
			);
		});

		it('Should exit process if no upgrade obj arg is passed AND getVersionUpdateInfo returns null - i.e. versions are current', async () => {
			getVersionUpdateInfo_stub.resolves();
			try {
				await upgrade_rw.upgrade();
			} catch (e) {
				//this is here to catch the error the exit stub is throwing so tests do not fail
			}

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.true;
			expect(processExit_stub.calledOnce).to.be.true;
			expect(processExit_stub.args[0][0]).to.equal(0);
			expect(consoleLog_stub.args[0][0]).to.equal('HarperDB version is current');
			expect(checkIfRunning_stub.calledOnce).to.be.false;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.false;
			expect(runUpgrade_stub.calledOnce).to.be.false;
		});

		it('Should exit process if no upgrade obj arg is passed AND there is an issue getting the current version', async () => {
			getVersionUpdateInfo_stub.resolves(new UpgradeObject());
			version_stub.get(() => null);
			try {
				await upgrade_rw.upgrade();
			} catch (e) {
				//this is here to catch the error the exit stub is throwing so tests do not fail
			}

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.true;
			expect(processExit_stub.calledOnce).to.be.true;
			expect(processExit_stub.args[0][0]).to.equal(1);
			expect(consoleLog_stub.args[0][0]).to.equal(
				'Current Version field missing from the package.json file.  Cannot continue with upgrade.  If you need support, please contact support@harperdb.io'
			);
			expect(log_notify_stub.args[0][0]).to.equal('Missing new version field from upgrade info object');
			expect(checkIfRunning_stub.calledOnce).to.be.false;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.false;
			expect(runUpgrade_stub.calledOnce).to.be.false;
		});

		it('Should exit process if upgradePrompt returns false', async () => {
			forceUpdatePrompt_stub.resolves(false);

			try {
				await upgrade_rw.upgrade();
			} catch (e) {
				//this is here to catch the error the exit stub is throwing so tests do not fail
			}

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.true;
			expect(checkIfRunning_stub.calledOnce).to.be.true;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.true;
			expect(processExit_stub.calledOnce).to.be.true;
			expect(processExit_stub.args[0][0]).to.equal(0);
			expect(consoleLog_stub.args[0][0]).to.equal('Cancelled upgrade, closing HarperDB');
			expect(runUpgrade_stub.calledOnce).to.be.false;
		});

		it('Should exit process with code 1 if upgradePrompt throws an exception', async () => {
			const test_err = new Error('AAHHH!  ERROR!');
			forceUpdatePrompt_stub.throws(test_err);

			try {
				await upgrade_rw.upgrade();
			} catch (e) {
				//this is here to catch the error the exit stub is throwing so tests do not fail
			}

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.true;
			expect(checkIfRunning_stub.calledOnce).to.be.true;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.true;
			expect(log_error_stub.args[0][0]).to.eql('There was an error when prompting user about upgrade.');
			expect(log_error_stub.args[1][0]).to.eql(test_err);
			expect(processExit_stub.calledOnce).to.be.true;
			expect(processExit_stub.args[0][0]).to.equal(1);
			expect(consoleLog_stub.args[0][0]).to.equal('Cancelled upgrade, closing HarperDB');
			expect(runUpgrade_stub.calledOnce).to.be.false;
		});

		it('Should exit process with code 1 if boot prop file does not exist - i.e. HDB has not been installed', async () => {
			fsExistsSync_stub.onFirstCall().returns(false);

			try {
				await upgrade_rw.upgrade();
			} catch (e) {
				//this is here to catch the error the exit stub is throwing so tests do not fail
			}

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.false;
			expect(checkIfRunning_stub.calledOnce).to.be.false;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.false;
			expect(runUpgrade_stub.calledOnce).to.be.false;
			expect(printToLogAndConsole_stub.args[0][0]).to.eql(
				'The hdb_boot_properties file was not found. Please install HDB.'
			);
			expect(processExit_stub.calledOnce).to.be.true;
			expect(processExit_stub.args[0][0]).to.equal(1);
		});

		it('Should exit process with code 1 if settings file does not exist - i.e. HDB has not been installed', async () => {
			fsExistsSync_stub.onFirstCall().returns(true);
			fsExistsSync_stub.onSecondCall().returns(false);

			try {
				await upgrade_rw.upgrade();
			} catch (e) {
				//this is here to catch the error the exit stub is throwing so tests do not fail
			}

			expect(getVersionUpdateInfo_stub.calledOnce).to.be.false;
			expect(checkIfRunning_stub.calledOnce).to.be.false;
			expect(forceUpdatePrompt_stub.calledOnce).to.be.false;
			expect(runUpgrade_stub.calledOnce).to.be.false;
			expect(printToLogAndConsole_stub.args[0][0]).to.eql(
				'The hdb settings file was not found. Please make sure HDB is installed.'
			);
			expect(processExit_stub.calledOnce).to.be.true;
			expect(processExit_stub.args[0][0]).to.equal(1);
			fsExistsSync_stub.reset();
		});

		it('Test error from runUpgrade is handled', async () => {
			fsExistsSync_stub.returns(true);
			runUpgrade_stub.throws(new Error('Error upgrading'));

			let error;
			try {
				await upgrade_rw.upgrade();
			} catch (err) {
				error = err;
			}

			expect(error.message).to.equal('Error upgrading');
		});
	});

	describe('runUpgrade()', () => {
		let processDirectives_stub;
		let insertHdbUpgradeInfo_stub;
		let runUpgrade_rw;
		const test_error = new Error('Oh boy...it is an error');

		before(() => {
			processDirectives_stub = sandbox.stub(directivesManager, 'processDirectives').resolves();
			insertHdbUpgradeInfo_stub = sandbox.stub(hdbInfoController, 'insertHdbUpgradeInfo').resolves();
			runUpgrade_rw = upgrade_rw.__get__('runUpgrade');
		});

		it('Nominal case', async () => {
			await runUpgrade_rw(TEST_UPGRADE_OBJ);
			expect(processDirectives_stub.calledOnce).to.be.true;
			expect(processDirectives_stub.args[0][0]).to.deep.equal(TEST_UPGRADE_OBJ);
			expect(insertHdbUpgradeInfo_stub.calledOnce).to.be.true;
			expect(insertHdbUpgradeInfo_stub.args[0][0]).to.deep.equal(TEST_CURR_VERS);
		});

		it('Should catch and throw exception from runUpgradeDirectives', async () => {
			processDirectives_stub.throws(test_error);

			let test_result;

			try {
				await runUpgrade_rw(TEST_UPGRADE_OBJ);
			} catch (e) {
				test_result = e;
			}
			expect(printToLogAndConsole_stub.calledOnce).to.be.true;
			expect(printToLogAndConsole_stub.args[0][0]).to.eql(
				'There was an error during the data upgrade.  Please check the logs.'
			);
			expect(test_result instanceof Error).to.be.true;
			expect(processDirectives_stub.calledOnce).to.be.true;
			expect(insertHdbUpgradeInfo_stub.called).to.be.false;

			processDirectives_stub.resolves();
		});

		it('Should catch an exception from insertHdbUpgradeInfo and continue - i.e. NOT rethrow', async () => {
			insertHdbUpgradeInfo_stub.throws(test_error);

			await runUpgrade_rw(TEST_UPGRADE_OBJ);

			expect(log_error_stub.calledTwice).to.be.true;
			expect(log_error_stub.args[0][0]).to.eql("Error updating the 'hdb_info' system table.");
			expect(log_error_stub.args[1][0]).to.deep.equal(test_error);
			expect(processDirectives_stub.calledOnce).to.be.true;
			expect(insertHdbUpgradeInfo_stub.called).to.be.true;
		});
	});

	describe('Test printToLogAndConsole', () => {
		let printToLogAndConsole;

		before(() => {
			let upgrade_rw = rewire(`../../bin/upgrade`);
			printToLogAndConsole = upgrade_rw.__get__('printToLogAndConsole');
		});

		it('Should log to console and final logger', () => {
			printToLogAndConsole('I am a log', 'error');
			expect(consoleLog_stub.calledOnce).to.be.true;
		});
	});
});
