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
const hdb_terms = require('../../utility/hdbTerms');

describe('Test hdbInfoController module - ', function() {
    let sandbox = undefined;
    let search_stub;
    let insert_stub;
    let version_stub;
    let getLatestHdbInfoRecord_stub;
    let consoleError_stub;
    const INFO_SEARCH_RESULT = [{
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
        insert_stub = sandbox.stub(insert, 'insert').resolves('');
        consoleError_stub = sandbox.stub(console, 'error').returns('');
        global.hdb_schema = undefined;
        global['hdb_schema'] = {system: {}};
        global['hdb_schema']['system'] = SystemSchema;
    });

    beforeEach(() => {
        search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
        hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    after(() => {
        sandbox.restore();
    })

    describe('Test updateHdbUpgradeInfo() ', () => {
        it('test insert nominal case', async function() {
            await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
        });

        it('test insert - search throws exception', async function() {
            search_stub.throws(new Error("Search error"));
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            let result = undefined;
            try {
                await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result instanceof Error, false, 'Got unexpected exception');
        });

        it('test insert - search returns no errors, still expect to run', async function() {
            search_stub.resolves([]);
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            let result = undefined;
            try {
                await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result, undefined, 'Got unexpected exception.');
        });

        it('test insert - insert throws exception', async function() {
            search_stub.resolves(INFO_SEARCH_RESULT);
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
            insert_stub.throws(new Error('Insert Error'));

            let result = undefined;
            try {
                await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result instanceof Error, true, 'expected insert to be called');
        });
    })

    describe('Test getVersionUpdateInfo() ', () => {
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

