"use strict";
const test_util = require('../test_utils');
test_util.preTestPrep();

const sinon = require('sinon');
const rewire = require('rewire');
const assert = require('assert');
// Need to rewire this since we have a promisified data member for search.  Remove rewire when search is asyncified.
const hdb_info_controller_rw = rewire('../../data_layer/hdbInfoController');
const SystemSchema = require('../../json/systemSchema');
const search = require('../../data_layer/search');
const insert = require('../../data_layer/insert');
const version = require('../../bin/version');

describe('Test hdbInfoController module - ', function() {
    let sandbox = undefined;
    let search_stub;
    let search_orig = hdb_info_controller_rw.__get__('p_search_search_by_value');
    let insert_stub;
    let update_stub;
    let updateHdbInfo;
    let version_stub;
    let getLatestHdbInfoRecord_stub;
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
        update_stub = sandbox.stub(insert, 'update').resolves('');
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

    describe('Test updateHdbUpgradeInfo() ', () => {
        it('test update nominal case', async function() {
            try {
                await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');

                assert.equal(search_stub.called, true, 'expected search to be called');
                assert.equal(update_stub.called, true, 'expected update to be called');
            } catch(err) {
                throw err;
            }
        });
        it('test update - search throws exception', async function() {
            try {
                search_stub = sandbox.stub().throws(new Error("Search error"));
                hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

                let result = undefined;
                try {
                    await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');
                } catch(err) {
                    result = err;
                }

                assert.equal(search_stub.called, true, 'expected search to be called');
                assert.equal(update_stub.called, true, 'expected update to be called');
                assert.equal(result instanceof Error, false, 'Got unexpected exception');
            } catch(err) {
                throw err;
            }
        });

        it('test update - search returns no errors, still expect to run', async function() {
            try {
                search_stub = sandbox.stub().resolves([]);
                hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

                let result = undefined;
                try {
                    await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');
                } catch(err) {
                    result = err;
                }

                assert.equal(search_stub.called, true, 'expected search to be called');
                assert.equal(update_stub.called, true, 'expected update to be called');
                assert.equal(result, undefined, 'Got unexpected exception.');
            } catch(err) {
                throw err;
            }
        });

        it('test update - insert throws exception', async function() {
            try {
                search_stub.resolves(INFO_SEARCH_RESULT);
                hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
                update_stub.throws(new Error('Update Error'));

                let result = undefined;

                try {
                    await hdb_info_controller_rw.updateHdbUpgradeInfo('2.0.0');
                } catch(err) {
                    result = err;
                }

                assert.equal(search_stub.called, true, 'expected search to be called');
                assert.equal(update_stub.called, true, 'expected insert to be called');
                assert.equal(result instanceof Error, true, 'expected insert to be called');
            } catch(err) {
                throw err;
            }
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

        beforeEach(() => {
            // sandbox = sinon.createSandbox();
            // global.hdb_schema = undefined;
            // global['hdb_schema'] = {system: {}};
            // global['hdb_schema']['system'] = SystemSchema;
        });

        afterEach(() => {
            // sandbox.resetHistory();
            // hdb_info_controller_rw.__set__('p_search_search_by_value', search_orig);
            // global.hdb_schema = null;
        });

        it('getVersionUpdateInfo nominal test', async () => {
            const expected_result = { "currentVersion": "1.3.0001", "upgradeVersion": "3.0.0" };
            let result;
            // search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
            // hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
            try {
                result = await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }
            assert.deepEqual(result, expected_result, 'Expected UpgradeObject result not returned');
        });

        it('getVersionUpdateInfo - data version equal to current version', async () => {
            const expected_result = null;
            let result;
            version_stub.returns(INFO_SEARCH_RESULT[1].hdb_version_num);
            try {
                result = await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }
            assert.deepEqual(result, expected_result, 'Expected null result not returned');
        });

        it('getVersionUpdateInfo - data version newer than current version', async () => {
            const expected_err_msg = 'Trying to downgrade HDB versions is not supported.';
            let result;
            version_stub.returns(INFO_SEARCH_RESULT[0].hdb_version_num);
            try {
                await hdb_info_controller_rw.getVersionUpdateInfo();
            } catch(err) {
                result = err;
            }
            assert.ok(result instanceof Error, 'Expected error to be thrown');
            assert.equal(result.message, expected_err_msg, 'Expected error message result not returned');
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

