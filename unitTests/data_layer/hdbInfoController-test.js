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

describe('Test updateHdbInfo', function() {
    let sandbox = undefined;
    let search_stub = undefined;
    let search_orig = hdb_info_controller_rw.__get__('p_search_search_by_value');
    let insert_stub = undefined;
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
    beforeEach(() => {
        sandbox = sinon.createSandbox();
        global.hdb_schema = undefined;
        global['hdb_schema'] = {system: {}};
        global['hdb_schema']['system'] = SystemSchema;
    });

    afterEach(() => {
        sandbox.reset();
        insert_stub.restore();
        hdb_info_controller_rw.__set__('p_search_search_by_value', search_orig);
        global.hdb_schema = null;
    });
    it('test update nominal case', async function() {
        try {
            let updateHdbInfo = hdb_info_controller_rw.__get__('updateHdbInfo');
            search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            insert_stub = sandbox.stub(insert, 'insert').resolves('');

            await updateHdbInfo('2.0.0');

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
        } catch(err) {
            throw err;
        }
    });
    it('test update - search throws exception', async function() {
        try {
            let updateHdbInfo = hdb_info_controller_rw.__get__('updateHdbInfo');
            search_stub = sandbox.stub().throws(new Error("Search error"));
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            insert_stub = sandbox.stub(insert, 'insert').resolves('');
            let result = undefined;
            try {
                await updateHdbInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result instanceof Error, false, 'Got unexpected exception');
        } catch(err) {
            throw err;
        }
    });
    it('test update - insert throws exception', async function() {
        try {
            let updateHdbInfo = hdb_info_controller_rw.__get__('updateHdbInfo');
            search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            insert_stub = sandbox.stub(insert, 'insert').throws(new Error('Insert Error'));
            let result = undefined;
            try {
                await updateHdbInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result instanceof Error, true, 'expected insert to be called');
        } catch(err) {
            throw err;
        }
    });
    it('test update - search returns no errors, still expect to run', async function() {
        try {
            let updateHdbInfo = hdb_info_controller_rw.__get__('updateHdbInfo');
            search_stub = sandbox.stub().resolves([]);
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            insert_stub = sandbox.stub(insert, 'insert').resolves('');
            let result = undefined;
            try {
                await updateHdbInfo('2.0.0');
            } catch(err) {
                result = err;
            }

            assert.equal(search_stub.called, true, 'expected search to be called');
            assert.equal(insert_stub.called, true, 'expected insert to be called');
            assert.equal(result, undefined, 'Got unexpected exception.');
        } catch(err) {
            throw err;
        }
    });
});

describe('Test getLatestDataVersion', function() {
    let sandbox = undefined;
    let search_stub = undefined;
    let search_orig = hdb_info_controller_rw.__get__('p_search_search_by_value');
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
    beforeEach(() => {
        sandbox = sinon.createSandbox();
        global.hdb_schema = undefined;
        global['hdb_schema'] = {system: {}};
        global['hdb_schema']['system'] = SystemSchema;
    });

    afterEach(() => {
        sandbox.reset();
        hdb_info_controller_rw.__set__('p_search_search_by_value', search_orig);
        global.hdb_schema = null;
    });
    it('getLatestDataVersion nominal test', async () => {
        let result = undefined;
        search_stub = sandbox.stub().resolves(INFO_SEARCH_RESULT);
        hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);
        try {
            result = await hdb_info_controller_rw.getLatestDataVersion();
        } catch(err) {
            result = err;
        }
        assert.equal(result, '1.3.0001', 'Expected 1.3.0001 result');
    });
    it('test getLatestDataVersion - search throws exception', async function() {
        try {
            search_stub = sandbox.stub().throws(new Error("Search error"));
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            let result = undefined;
            try {
                result = await hdb_info_controller_rw.getLatestDataVersion();
            } catch(err) {
                result = err;
            }
            assert.equal(result, undefined, 'Expected undefined result');
        } catch(err) {
            throw err;
        }
    });
    it('test getLatestDataVersion - search returns no errors, expect undefined back', async function() {
        try {
            search_stub = sandbox.stub().resolves([]);
            hdb_info_controller_rw.__set__('p_search_search_by_value', search_stub);

            let result = undefined;
            try {
                result = await hdb_info_controller_rw.getLatestDataVersion();
            } catch(err) {
                result = err;
            }
            assert.equal(result, undefined, 'Expected undefined result');
        } catch(err) {
            throw err;
        }
    });
});