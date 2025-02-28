'use strict';
const test_util = require('../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
// Need to rewire this since we have a promisified data member for search.  Remove rewire when search is asyncified.
const hdb_info_controller_rw = rewire('../../dataLayer/hdbInfoController');
const insert = require('../../dataLayer/insert');
const { packageJson } = require('../../utility/packageUtils');
const harper_logger = require('../../utility/logging/harper_logger');
const hdb_terms = require('../../utility/hdbTerms');
const directiveManager = require('../../upgrade/directives/directivesController');
const os = require('os');
const chalk = require('chalk');
const util = require('util');
const global_schema = require('../../utility/globalSchema');

let sandbox;
let search_stub;
let insert_stub;
let version_stub;
let getLatestHdbInfoRecord_stub;
let hasUpgradesRequired_stub;
let checkIfInstallIsSupported_stub;
let consoleLog_stub;
let consoleError_stub;
let log_info_stub;
const OLD_VERSION_NUM = '2.0.1';
const NEWER_VERSION_NUM = '5.0.1';
const OLD_VERSION_ERR =
	'You are attempting to upgrade from an old instance of HarperDB that is no longer supported. ' +
	'In order to upgrade to this version, you must do a fresh install. If you need support, ' +
	'please contact support@harperdb.io';
const INFO_SEARCH_RESULT = [
	{
		info_id: 1,
		data_version_num: '4.0.0',
		hdb_version_num: '4.0.0',
	},
	{
		info_id: 2,
		data_version_num: '4.1.0',
		hdb_version_num: '4.1.0',
	},
];
let p_setSchemaDataToGlobal = util.promisify(global_schema.setSchemaDataToGlobal);

describe('Test hdbInfoController module ', function () {
	before(() => {
		sandbox = sinon.createSandbox();
		search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
		hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
		insert_stub = sandbox.stub(insert, 'insert').resolves();
		consoleLog_stub = sandbox.stub(console, 'log').returns();
		consoleError_stub = sandbox.stub(console, 'error').returns();
		log_info_stub = sandbox.stub(harper_logger, 'info').returns();
		hdb_info_controller_rw.__set__('MINIMUM_SUPPORTED_VERSION_NUM', '2.9.9');
		hdb_info_controller_rw.__set__('DEFAULT_DATA_VERSION_NUM', '2.3.0');
	});

	afterEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
		rewire('../../dataLayer/hdbInfoController');
	});

	describe('Test insertHdbInstallInfo() ', () => {
		it('test insert install info - nominal case', async function () {
			const test_vers = '2.0.0';
			await hdb_info_controller_rw.insertHdbInstallInfo(test_vers);

			assert.equal(insert_stub.called, true, 'expected insert to be called');
			assert.equal(insert_stub.args[0][0].records[0].info_id, 1, 'expected info object to have id = 1');
			assert.equal(
				insert_stub.args[0][0].records[0].data_version_num,
				test_vers,
				'expected info object to have data version set to 2.0.0'
			);
			assert.equal(
				insert_stub.args[0][0].records[0].hdb_version_num,
				test_vers,
				'expected info object to have hdb version set to 2.0.0'
			);
		});

		it('test insert install info - throws exception', async function () {
			const test_err = new Error('Insert error');
			insert_stub.throws(test_err);

			let result = undefined;
			try {
				await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
			} catch (err) {
				result = err;
			}

			assert.deepEqual(result, test_err, 'Did not get expected exception');
			insert_stub.reset();
		});
	});

	describe('Test insertHdbUpgradeInfo() ', () => {
		it('test insert nominal case', async function () {
			await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');

			assert.equal(search_stub.called, true, 'expected search to be called');
			assert.equal(insert_stub.called, true, 'expected insert to be called');
		});

		it('test insert - search throws exception', async function () {
			search_stub.throws(new Error('Search error'));

			let result = undefined;
			try {
				await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
			} catch (err) {
				result = err;
			}

			assert.equal(search_stub.called, true, 'expected search to be called');
			assert.equal(insert_stub.called, true, 'expected insert to be called');
			assert.equal(result instanceof Error, false, 'Got unexpected exception');
		});

		it('test insert - search returns no errors, still expect to run', async function () {
			search_stub.resolves([]);

			let result = undefined;
			try {
				await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
			} catch (err) {
				result = err;
			}

			assert.equal(search_stub.called, true, 'expected search to be called');
			assert.equal(insert_stub.called, true, 'expected insert to be called');
			assert.equal(result, undefined, 'Got unexpected exception.');
		});

		it('test insert - insert throws exception', async function () {
			search_stub.resolves(INFO_SEARCH_RESULT);
			insert_stub.throws(new Error('Insert Error'));

			let result = undefined;
			try {
				await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
			} catch (err) {
				result = err;
			}

			assert.equal(search_stub.called, true, 'expected search to be called');
			assert.equal(insert_stub.called, true, 'expected insert to be called');
			assert.equal(result instanceof Error, true, 'expected insert to be called');
		});
	});

	describe('Test getAllHdbInfoRecords() ', () => {
		let getAllHdbInfoRecords_rw;

		before(() => {
			getAllHdbInfoRecords_rw = hdb_info_controller_rw.__get__('getAllHdbInfoRecords');
		});

		it('Should return the results from the hdb_info table search - nominal case', async function () {
			const result = await getAllHdbInfoRecords_rw();

			assert.deepEqual(result, INFO_SEARCH_RESULT, 'expected results from search call');
			assert.equal(result.length, INFO_SEARCH_RESULT.length, 'results should be returned as an array w/ length = 2');
		});

		it('Should log error if thrown from search function and return []', async function () {
			const test_err = new Error('Search ERROR!');
			search_stub.throws(test_err);
			getAllHdbInfoRecords_rw = hdb_info_controller_rw.__get__('getAllHdbInfoRecords');

			let result;
			try {
				result = await getAllHdbInfoRecords_rw();
			} catch (err) {
				result = err;
			}

			assert.equal(log_info_stub.calledOnce, true, 'expected error to be logged');
			assert.equal(log_info_stub.args[0][0].message, test_err.message, 'expected error message to be logged');
			assert.deepEqual(result, [], 'expected an empty array to be returned');
		});
	});

	describe('Test getLatestHdbInfoRecord() ', () => {
		let getLatestHdbInfoRecord_rw;

		before(() => {
			search_stub.resolves(INFO_SEARCH_RESULT);
			getLatestHdbInfoRecord_rw = hdb_info_controller_rw.__get__('getLatestHdbInfoRecord');
		});

		it('It should return the most recent info record', async function () {
			const result = await getLatestHdbInfoRecord_rw();

			assert.deepEqual(result, INFO_SEARCH_RESULT[1], 'expected a different record in result');
		});

		it('It should return undefined if search returns no records', async function () {
			search_stub.resolves([]);
			const result = await getLatestHdbInfoRecord_rw();

			assert.equal(result, undefined, 'expected return value to be undefined');
		});
	});

	describe('Test getVersionUpdateInfo() ', () => {
		beforeEach(() => {
			getLatestHdbInfoRecord_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT[1]);
			hdb_info_controller_rw.__set__('getLatestHdbInfoRecord', getLatestHdbInfoRecord_stub);
			insert_stub.resolves();
		});

		before(() => {
			version_stub = sandbox.stub(packageJson, 'version').get(() => '4.0.0');
			hasUpgradesRequired_stub = sandbox.stub(directiveManager, 'hasUpgradesRequired').returns(true);
			checkIfInstallIsSupported_stub = sandbox.stub().returns();
			process.argv.push('--CONFIRM_DOWNGRADE', 'yes');
		});

		it('getVersionUpdateInfo nominal test', async () => {
			const expected_result = { data_version: '4.1.0', upgrade_version: '4.0.0' };
			let result;
			try {
				result = await hdb_info_controller_rw.getVersionUpdateInfo();
			} catch (err) {
				result = err;
			}

			assert.deepEqual(result, expected_result, 'Expected UpgradeObject result not returned');
			assert.equal(insert_stub.called, true, 'expected insert to be called');
		});

		it('getVersionUpdateInfo - no result returned if versions are the same', async () => {
			const expected_result = null;
			version_stub.get(() => INFO_SEARCH_RESULT[1].hdb_version_num);

			let result;
			try {
				result = await hdb_info_controller_rw.getVersionUpdateInfo();
			} catch (err) {
				result = err;
			}

			assert.deepEqual(result, expected_result, 'Expected null result not returned');
		});

		it('getVersionUpdateInfo - pre-upgrade version newer than upgrade version, but only minor difference', async () => {
			version_stub.get(() => INFO_SEARCH_RESULT[0].hdb_version_num);
			await hdb_info_controller_rw.getVersionUpdateInfo();
			// expect no error to be thrown
		});

		it('getVersionUpdateInfo nominal test, upgrade that does not require a directive', async () => {
			version_stub.get(() => '4.2.0');
			hasUpgradesRequired_stub.returns(false);
			await hdb_info_controller_rw.getVersionUpdateInfo();
			assert.equal(insert_stub.called, true, 'expected insert to be called');
		});

		it('getVersionUpdateInfo - error thrown if downgrading major version', async () => {
			const test_error ='Trying to downgrade major HDB versions is not supported.';
			version_stub.get(() => OLD_VERSION_NUM);

			let result;
			try {
				await hdb_info_controller_rw.getVersionUpdateInfo();
			} catch (err) {
				result = err;
			}

			assert.ok(result instanceof Error, 'Expected error to be thrown');
			assert.equal(result.message, test_error, 'Expected error message to be thrown');
			assert.ok(consoleLog_stub.calledOnce, 'Data version message was not logged to console');
			assert.equal(
				consoleLog_stub.args[0][0],
				chalk.yellow(`This instance's data was last run on version ${INFO_SEARCH_RESULT[1].data_version_num}`),
				'Console message not correct'
			);
			assert.ok(consoleError_stub.calledOnce, 'Error message was not logged to console');
			assert.equal(
				consoleError_stub.args[0][0],
				chalk.red(
					`You have installed a version lower than the version that your data was created on or was upgraded to. This may cause issues and is currently not supported.${os.EOL}${hdb_terms.SUPPORT_HELP_MSG}`
				),
				'Console message not correct'
			);
		});

		it('getVersionUpdateInfo - error thrown if version is too old', async () => {
			getLatestHdbInfoRecord_stub.resolves(undefined);
			version_stub.get(() => NEWER_VERSION_NUM);

			let result;
			try {
				await hdb_info_controller_rw.getVersionUpdateInfo();
			} catch (err) {
				result = err;
			}

			assert.ok(result instanceof Error, 'Expected error to be thrown');
			assert.equal(result.message, OLD_VERSION_ERR, 'Expected error message to be thrown');
		});

		it('test getVersionUpdateInfo - version does not exist', async function () {
			version_stub.get(() => null);

			let result;
			try {
				await hdb_info_controller_rw.getVersionUpdateInfo();
			} catch (err) {
				result = err;
			}

			assert.ok(result instanceof Error, 'Expected error to be thrown');
			assert.equal(result.message, `Could not find the version number in the package.json file.`, 'Expected error message to be re-thrown');
		});
	});

	describe('Test checkIfInstallIsSupported()', () => {
		before(() => {
			insert_stub.resolves();
		});

		it('Test it throws error message if hdb_info table doesnt exist', async () => {
			const check_if_install_supported_rw = hdb_info_controller_rw.__get__('checkIfInstallIsSupported');

			await p_setSchemaDataToGlobal();
			if (global.hdb_schema.system.hdb_info) {
				delete global.hdb_schema.system.hdb_info;
			}

			let result;
			try {
				check_if_install_supported_rw();
			} catch (err) {
				result = err;
			}

			assert.ok(result instanceof Error, 'Expected error to be thrown');
			assert.equal(result.message, OLD_VERSION_ERR, 'Expected error message to be thrown');
		});

		it('Test it throws error message if data version is too old', async () => {
			const has_own_property_stub = sandbox.stub(global.hdb_schema.system, 'hasOwnProperty').returns(true);
			const check_if_install_supported_rw = hdb_info_controller_rw.__get__('checkIfInstallIsSupported');

			let result;
			try {
				check_if_install_supported_rw('2.9.0');
			} catch (err) {
				result = err;
			}

			assert.ok(result instanceof Error, 'Expected error to be thrown');
			assert.equal(result.message, OLD_VERSION_ERR, 'Expected error message to be thrown');
			assert.equal(has_own_property_stub.returnValues[0], true, 'expected hasOwnProperty stub to return true');
		});
	});
});
