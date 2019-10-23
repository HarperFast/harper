'use strict';

const { preTestPrep, testError} = require('../../../test_utils');
preTestPrep();

const rewire = require('rewire');
let heDropSchema_rw = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropSchema');
let validateDropSchema_rw = heDropSchema_rw.__get__('validateDropSchema');

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const TEST_SCHEMA = "test_schema";
const DROP_SCHEMA_OBJ = {
    schema: TEST_SCHEMA
};
const TEST_TABLE_RESULTS = {
    table1: { name: 'table1'},
    table2: { name: 'table2'},
    table3: { name: 'table3'}
};

let sandbox;
let heDropTable_stub;
let heDeleteRecords_stub;
let throw_error_stub;
const err_msg = 'Error msg';
let return_schema_hash = () => TEST_SCHEMA;
let return_tables = () => TEST_TABLE_RESULTS;
let return_nothing = () => {};

function resetTests() {
    sandbox.resetHistory();
    heDropSchema_rw.__set__('validateDropSchema', return_schema_hash);
    heDropSchema_rw.__set__('heGetDataByValue', return_tables);
    heDropSchema_rw.__set__('heDropTable', heDropTable_stub);
    heDropSchema_rw.__set__('heDeleteRecords', heDeleteRecords_stub);
}

describe('heDropSchema', () => {
    before(() => {
        sandbox = sinon.createSandbox();
        heDropTable_stub = sandbox.stub().returns();
        heDeleteRecords_stub = sandbox.stub().returns()
        throw_error_stub = sandbox.stub().throws(new Error(err_msg));
        resetTests();
    });

    beforeEach(() => {
        resetTests();
    });

    after(() => {
        sandbox.reset();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropSchema');
    });

    it('Should drop all tables associated with schema', () => {
        heDropSchema_rw(DROP_SCHEMA_OBJ);
        expect(heDropTable_stub.callCount).to.equal(Object.keys(TEST_TABLE_RESULTS).length);
        expect(heDeleteRecords_stub.calledOnce).to.equal(true);
    });

    it('Should return an error if thrown from validateDropSchema and not call other methods', () => {
        heDropSchema_rw.__set__('validateDropSchema', throw_error_stub);
        let test_result;
        try {
            heDropSchema_rw(DROP_SCHEMA_OBJ);
        } catch(e) {
            test_result = e;
        }
        expect(test_result.message).to.equal(err_msg);
        expect(heDropTable_stub.called).to.equal(false);
        expect(heDeleteRecords_stub.called).to.equal(false);
    });

    it('Should return an error if thrown from heDropTable', () => {
        heDropSchema_rw.__set__('heDropTable', throw_error_stub);
        let test_result;
        try {
            heDropSchema_rw(DROP_SCHEMA_OBJ);
        } catch(e) {
            test_result = e;
        }
        expect(test_result.message).to.equal(err_msg);
        expect(heDeleteRecords_stub.called).to.equal(false);
    });

    it('Should return an error if thrown from heDeleteRecords', () => {
        heDropSchema_rw.__set__('heDeleteRecords', throw_error_stub);
        let test_result;
        try {
            heDropSchema_rw(DROP_SCHEMA_OBJ);
        } catch(e) {
            test_result = e;
        }
        expect(test_result.message).to.equal(err_msg)
    });

    describe('validateDropSchema', () => {
        const return_schema = {
            test_schema: {name: TEST_SCHEMA}
        };
        let heGetDataByHash_stub;

        before(() => {
            heGetDataByHash_stub = sandbox.stub().returns(return_schema);
            heDropSchema_rw.__set__('heGetDataByHash', heGetDataByHash_stub);
        })

        it ('Return the schema name if it exists', () => {
            const test_result = validateDropSchema_rw(TEST_SCHEMA);
            expect(test_result).to.equal(test_result);
        })

        it ('Return an error if schema name does not exist in system data store', () => {
            heDropSchema_rw.__set__('heGetDataByHash', return_nothing);
            const expected_err_msg = `schema '${TEST_SCHEMA}' does not exist`
            let test_result;
            try {
                validateDropSchema_rw(TEST_SCHEMA);
            } catch(e) {
                test_result = e;
            }
            expect(test_result.message).to.equal(expected_err_msg);
        })

        it ('Return an error if search returns an error', () => {
            heDropSchema_rw.__set__('heGetDataByHash', sandbox.stub().throws(new Error(err_msg)));
            let test_result;
            try {
                validateDropSchema_rw(TEST_SCHEMA);
            } catch(e) {
                test_result = e;
            }
            expect(test_result.message).to.equal(err_msg);
        })
    })

});