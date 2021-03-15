"use strict";
const test_util = require('../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
// Need to rewire this since we have a promisified data member for search.  Remove rewire when search is asyncified.
const hdb_info_controller_rw = rewire('../../data_layer/hdbInfoController');
const SystemSchema = require('../../json/systemSchema');
const insert = require('../../data_layer/insert');
const version = require('../../bin/version');
const harper_logger = require('../../utility/logging/harper_logger');
const hdb_terms = require('../../utility/hdbTerms');

describe('Test hdbInfoController module - ', function() {
    let sandbox = undefined;
    let search_stub;
    let insert_stub;
    let version_stub;
    let getLatestHdbInfoRecord_stub;
    let consoleError_stub;
    let log_info_stub;
    const INFO_SEARCH_RESULT = [
        {
            info_id: 1,
            data_version_num: "1.2.0001",
            hdb_version_num: "1.2.0001"
        },
        {
            info_id: 2,
            data_version_num: "1.3.0001",
            hdb_version_num: "1.3.0001"
        }
    ];

    before(() => {
        sandbox = sinon.createSandbox();
        search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
        hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
        insert_stub = sandbox.stub(insert, 'insert').resolves();
        consoleError_stub = sandbox.stub(console, 'error').returns();
        log_info_stub = sandbox.stub(harper_logger, 'info').returns();
        global.hdb_schema = undefined;
        global['hdb_schema'] = {system: {}};
        global['hdb_schema']['system'] = SystemSchema;
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    after(() => {
        sandbox.restore();
        rewire('../../data_layer/hdbInfoController');
    })

    describe('Test insertHdbInstallInfo() ', () => {
        it('test insert install info - nominal case', async function() {
            const test_vers = '2.0.0';
            await hdb_info_controller_rw.insertHdbInstallInfo(test_vers);

            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(insert_stub.args[0][0].records[0].info_id, 1, 'expected info object to have id = 1');
            assert.equal(insert_stub.args[0][0].records[0].data_version_num, test_vers, 'expected info object to have data version set to 2.0.0');
            assert.equal(insert_stub.args[0][0].records[0].hdb_version_num, test_vers, 'expected info object to have hdb version set to 2.0.0');
        });

        it('test insert install info - throws exception', async function() {
            const test_err = new Error("Insert error");
            insert_stub.throws(test_err);

            let result = undefined;
            try {
                await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.deepEqual(result, test_err, 'Did not get expected exception');
            insert_stub.reset();
        });
    })

    describe('Test insertHdbUpgradeInfo() ', () => {
        it('test insert nominal case', async function() {
            await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
        });

        it('test insert - search throws exception', async function() {
            search_stub.throws(new Error("Search error"));

            let result = undefined;
            try {
                await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result instanceof Error, false, 'Got unexpected exception');
        });

        it('test insert - search returns no errors, still expect to run', async function() {
            search_stub.resolves([]);

            let result = undefined;
            try {
                await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result, undefined, 'Got unexpected exception.');
        });

        it('test insert - insert throws exception', async function() {
            search_stub.resolves(INFO_SEARCH_RESULT);
            insert_stub.throws(new Error('Insert Error'));

            let result = undefined;
            try {
                await hdb_info_controller_rw.insertHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result instanceof Error, true, 'expected insert to be called');
        });
    })

    describe('Test searchInfo() ', () => {
        let searchInfo_rw;

        before(() => {
            searchInfo_rw = hdb_info_controller_rw.__get__('searchInfo');
        })

        it('Should return the results from the hdb_info table search - nominal case', async function() {
            const result = await searchInfo_rw();

            assert.deepEqual(result, INFO_SEARCH_RESULT, 'expected results from search call');
            assert.equal(result.length, INFO_SEARCH_RESULT.length, 'results should be returned as an array w/ length = 2');
        });

        it('Should log error if thrown from search function and return []', async function() {
            const test_err = new Error("Search ERROR!");
            search_stub.throws(test_err);
            searchInfo_rw = hdb_info_controller_rw.__get__('searchInfo');

            let result;
            try {
                result = await searchInfo_rw();
            } catch(err) {
                result = err;
            }

            assert.equal(log_info_stub.calledOnce, true, 'expected error to be logged');
            assert.equal(log_info_stub.args[0][0].message, test_err.message, 'expected error message to be logged');
            assert.deepEqual(result, [], 'expected an empty array to be returned');
        });
    })

    describe('Test getLatestHdbInfoRecord() ', () => {
        let getLatestHdbInfoRecord_rw;

        before(() => {
            search_stub.resolves(INFO_SEARCH_RESULT);
            getLatestHdbInfoRecord_rw = hdb_info_controller_rw.__get__('getLatestHdbInfoRecord');
        })

        it('It should return the most recent info record', async function() {
            const result = await getLatestHdbInfoRecord_rw();

            assert.deepEqual(result, INFO_SEARCH_RESULT[1], 'expected a different record in result');
        });

        it('It should return undefined if search returns no records', async function() {
            search_stub.resolves([]);
            const result = await getLatestHdbInfoRecord_rw();

            assert.equal(result, undefined, 'expected return value to be undefined');
        });
    })

    describe('Test getVersionUpdateInfo() ', () => {
        before(() => {
            getLatestHdbInfoRecord_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT[1]);
            hdb_info_controller_rw.__set__('getLatestHdbInfoRecord', getLatestHdbInfoRecord_stub);
            version_stub = sandbox.stub(version, 'version').returns('3.0.0');
        })

        it('getVersionUpdateInfo nominal test', async () => {
            const expected_result = { "currentVersion": "1.3.0001", "upgradeVersion": "3.0.0" };

            let result;
            try {
                result = await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }

            assert.deepEqual(result, expected_result, 'Expected UpgradeObject result not returned');
        });

        it('getVersionUpdateInfo - data version equal to current version', async () => {
            const expected_result = null;
            version_stub.returns(INFO_SEARCH_RESULT[1].hdb_version_num);

            let result;
            try {
                result = await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }

            assert.deepEqual(result, expected_result, 'Expected null result not returned');
        });

        it('getVersionUpdateInfo - data version newer than current version', async () => {
            const expected_err_msg = 'Trying to downgrade HDB versions is not supported.';
            version_stub.returns(INFO_SEARCH_RESULT[0].hdb_version_num);

            let result;
            try {
                await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }

            assert.ok(result instanceof Error, 'Expected error to be thrown');
            assert.equal(result.message, expected_err_msg, 'Expected error message result not returned');
            assert.ok(consoleError_stub.calledOnce, 'Error message was not logged to console');
            assert.equal(consoleError_stub.args[0][0], `You have installed a version lower than version that your data was created on.  This may cause issues and is not supported.  ${hdb_terms.SUPPORT_HELP_MSG}`,'Console message not correct');
        });

        it('test getVersionUpdateInfo - version throws exception', async function() {
            const test_error = "Version error";
            version_stub.throws(new Error(test_error));

            let result;
            try {
                await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }

            assert.ok(result instanceof Error, 'Expected error to be thrown');
            assert.equal(result.message, test_error,'Expected error message to be re-thrown');
        });
    });
});

