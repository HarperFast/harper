'use strict';

const sinon = require('sinon');
const chai = require('chai');
const { expect } = chai;

const rewire = require('rewire');
let upgrade_rw;

const hdbInfoController = require('#src/dataLayer/hdbInfoController');
const directivesManager = require('#src/upgrade/directivesManager');
const { packageJson } = require('#src/utility/packageUtils');
const { UpgradeObject } = require('#src/upgrade/UpgradeObjects');

const TEST_CURR_VERS = '3.0.0';
const TEST_DATA_VERS = '2.9.9';
const TEST_UPGRADE_OBJ = new UpgradeObject(TEST_DATA_VERS, TEST_CURR_VERS);

describe('Test upgrade.js', () => {
	let sandbox = sinon.createSandbox();
	let consoleLog_stub;
	let printToLogAndConsole_stub;
	const log_notify_stub = sandbox.stub().callsFake(() => {});
	const log_error_stub = sandbox.stub().callsFake(() => {});
	const log_info_stub = sandbox.stub().callsFake(() => {});
	const logger_fake = {
		notify: log_notify_stub,
		error: log_error_stub,
		info: log_info_stub,
	};

	before(() => {
		upgrade_rw = rewire('#js/bin/upgrade');
		upgrade_rw.__set__('hdbLogger', logger_fake);
		consoleLog_stub = sandbox.stub(console, 'log').returns();
		printToLogAndConsole_stub = sandbox.stub().returns();
		upgrade_rw.__set__('printToLogAndConsole', printToLogAndConsole_stub);
		sandbox.stub(process, 'exit');
		sandbox.stub(packageJson, 'version').get(() => TEST_CURR_VERS);
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
		rewire(`#js/bin/upgrade`);
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
			let upgrade_rw = rewire(`#js/bin/upgrade`);
			printToLogAndConsole = upgrade_rw.__get__('printToLogAndConsole');
		});

		it('Should log to console and final logger', () => {
			printToLogAndConsole('I am a log', 'error');
			expect(consoleLog_stub.calledOnce).to.be.true;
		});
	});
});
