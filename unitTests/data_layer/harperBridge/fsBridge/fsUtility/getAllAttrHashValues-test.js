'use strict';

const test_utils = require('../../../../test_utils');
const { mochaAsyncWrapper, preTestPrep } = test_utils;
preTestPrep();

const rewire = require('rewire');
let getAllAttrHashValues_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAllAttrHashValues');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const TEST_FILE_RESULTS = ['1.hdb', '2.hdb', '3.hdb', '4.hdb', '5.hdb'];
const TEST_HASH_RESULTS = [1, 2, 3, 4, 5];
const TEST_DIR_PATH = 'test/dir/hdb';

let sandbox;
let fsReadDir_stub;
let fs_spy;
let isEmptyOrZeroLength_stub;
let stripFileExtension_spy;
let commonUtils_spy;
let commonUtils_rw;
let autoCast_rw;
let logError_spy;
let log_spy;

function setupTestSpies() {
    sandbox = sinon.createSandbox();
    fsReadDir_stub = sandbox.stub().returns(TEST_FILE_RESULTS);
    fs_spy = { readdir: fsReadDir_stub };
    getAllAttrHashValues_rw.__set__('fs', fs_spy);
    commonUtils_rw = getAllAttrHashValues_rw.__get__('common_utils');
    autoCast_rw = commonUtils_rw.autoCast;
    stripFileExtension_spy = sandbox.spy(commonUtils_rw, 'stripFileExtension');
    isEmptyOrZeroLength_stub = sandbox.stub().returns(false);
    commonUtils_spy = { stripFileExtension: stripFileExtension_spy, isEmptyOrZeroLength: isEmptyOrZeroLength_stub, autoCast: autoCast_rw };
    getAllAttrHashValues_rw.__set__('common_utils', commonUtils_spy);
    logError_spy = sandbox.spy();
    log_spy = { error: logError_spy };
    getAllAttrHashValues_rw.__set__('log', log_spy);
}

describe('getAllAttrHashValues', () => {
    before(() => {
        setupTestSpies();
    });

    afterEach(() => {
        sandbox.reset();
    });

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAllAttrHashValues');
    });

    it('Should return hash values without hdb extension', mochaAsyncWrapper(async () => {
        const test_result = await getAllAttrHashValues_rw(TEST_DIR_PATH);

        expect(test_result.length).to.equal(TEST_HASH_RESULTS.length);
        expect(test_result).to.deep.equal(TEST_HASH_RESULTS);
    }));

    it('Should return empty array if readdir returns no results', mochaAsyncWrapper(async () => {
        fsReadDir_stub.returns([]);
        getAllAttrHashValues_rw.__set__('fs', fs_spy);
        const test_result = await getAllAttrHashValues_rw(TEST_DIR_PATH);

        expect(test_result.length).to.equal(0);
        expect(test_result).to.deep.equal([]);

        fsReadDir_stub.reset();
        getAllAttrHashValues_rw.__set__('fs', fs_spy);
    }));

    it('Should log an error if readdir throws an error', mochaAsyncWrapper(async () => {
        const test_err_msg = 'fs error';
        fsReadDir_stub.throwsException(new Error(test_err_msg));
        getAllAttrHashValues_rw.__set__('fs', fs_spy);

        let test_result = await getAllAttrHashValues_rw(TEST_DIR_PATH);

        expect(logError_spy.calledOnce).to.equal(true);
        expect(test_result).to.deep.equal([]);

        fsReadDir_stub.reset();
        getAllAttrHashValues_rw.__set__('fs', fs_spy);
    }));
});
