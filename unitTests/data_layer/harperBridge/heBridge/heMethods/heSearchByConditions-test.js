'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let heSearchByConditions_rw = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heSearchByConditions');

const { mochaAsyncWrapper } = require('../../../../test_utils');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

let sandbox;
let multiConditionSearch_rw;
let multiConditionSearch_stub;
let heSearchByHash_stub;
let heGetDataByValue_stub;

const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

let test_search_attr1 = 'breed';
let test_search_attr2 = 'name';
const test_search_val1 = 'Poodle';
const test_search_val2 = 'Sarah';
const test_expected_hash_result1 = ['1','2','3'];
const test_expected_hash_result2 = ['1','3'];
const test_conditions1 = [
    {
        "and":
            {"=":[test_search_attr1, test_search_val1]}
    }
];
const test_conditions2 = [
    {
        "and":
            {"=":[test_search_attr1, test_search_val1]}
    },
    {
        "and":
            {"=":[test_search_attr2, test_search_val2]}
    }
];

// Search Object
// {
//   schema:String, // schema to search
//   table:String, // table to search
//   conditions: Array // search condition to filter rows on
//   get_attributes:Array // attributes to return with search result
// }
const TEST_SEARCH_OBJ = (conditions) => ({
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    conditions: conditions,
    get_attributes: "*"

});

const ERR_MSGS = {
    SCHEMA: "Schema can't be blank",
    TABLE: "Table can't be blank",
    CONDITIONS: "Conditions can't be blank",
    GET_ATTR: "Get attributes can't be blank"
};

const hash_search_return = () => [{}];
const value_search_1 = () => ({1: {}, 2: {}, 3: {}});
const value_search_2 = () => ({1: {}, 3:{}});
const return_null_stub = () => null;

function setupTestSpies() {
    sandbox = sinon.createSandbox();
    //rewire heSearchByHash w/ stub
    heSearchByHash_stub = sandbox.stub().returns(hash_search_return());
    heSearchByConditions_rw.__set__('heSearchByHash', heSearchByHash_stub);
    //rewire heGetDataByValue w/ stub
    heGetDataByValue_stub = sandbox.stub();
    heSearchByConditions_rw.__set__('heGetDataByValue', heGetDataByValue_stub);
    //rewire multiConditionSearch w/ stub
    multiConditionSearch_rw = heSearchByConditions_rw.__get__('multiConditionSearch');
    multiConditionSearch_stub = sandbox.stub().callsFake(multiConditionSearch_rw);
    heSearchByConditions_rw.__set__('multiConditionSearch', multiConditionSearch_stub);
}

describe('heSearchByCondition', () => {

    before(() => {
        setupTestSpies();
        global.hdb_schema = {
            [TEST_SCHEMA]: {
                [TEST_TABLE_DOG]: {
                    schema: TEST_SCHEMA,
                    name: TEST_TABLE_DOG,
                    hash_attribute: HASH_ATTRIBUTE,
                    attributes: [{attribute: 'age'}, {attribute: 'breed'}, {attribute: 'id'}, {attribute: 'name'}]
                }
            },
        };
    });

    afterEach(() => {
        sandbox.resetHistory();
    })

    after(() => {
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heSearchByConditions');
    });

    it('Single condition - should call heSearchByHash with all hashes returned for value condition', mochaAsyncWrapper(async () => {
        heGetDataByValue_stub.returns(value_search_1())
        heSearchByConditions_rw.__set__('heGetDataByValue', heGetDataByValue_stub);

        await heSearchByConditions_rw(TEST_SEARCH_OBJ(test_conditions1));

        expect(heSearchByHash_stub.args[0][0].hash_values).to.deep.equal(test_expected_hash_result1);
        expect(heSearchByHash_stub.args[0][0].get_attributes).to.equal('*');
        expect(heGetDataByValue_stub.calledOnce).to.equal(true);
        expect(heGetDataByValue_stub.args[0][0].get_attributes).to.deep.equal([HASH_ATTRIBUTE]);

        heGetDataByValue_stub.reset();
    }));

    it('Multi condition - should call heSearchByHash with overlapping hashes returned for both value conditions', mochaAsyncWrapper(async () => {
        heGetDataByValue_stub.onCall(0).returns(value_search_1());
        heGetDataByValue_stub.onCall(1).returns(value_search_2());
        heSearchByConditions_rw.__set__('heGetDataByValue', heGetDataByValue_stub);

        await heSearchByConditions_rw(TEST_SEARCH_OBJ(test_conditions2));

        expect(heSearchByHash_stub.args[0][0].hash_values).to.deep.equal(test_expected_hash_result2);
        expect(heSearchByHash_stub.args[0][0].get_attributes).to.equal('*');
        expect(heGetDataByValue_stub.calledTwice).to.equal(true);
        expect(heGetDataByValue_stub.args[0][0].get_attributes).to.deep.equal([HASH_ATTRIBUTE]);

        heGetDataByValue_stub.reset();
    }));

    it('Should return error if empty object is passed in', mochaAsyncWrapper(async () => {
        let err;
        try{
            await heSearchByConditions_rw({});
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal("Schema can't be blank,Table can't be blank,Conditions can't be blank");
    }));

    it('Should return error if empty string is passed in for schema', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = TEST_SEARCH_OBJ(test_conditions1);
        TEMP_SEARCH_OBJECT.schema = "";
        let err;

        try{
            err = await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.SCHEMA);
    }));

    it('Should return error if empty string is passed in for table', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = TEST_SEARCH_OBJ(test_conditions1);
        TEMP_SEARCH_OBJECT.table = "";
        let err;

        try{
            err = await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.TABLE);
    }));

    // TODO: fix error handling for this scenario - currently, this returns 'Cannot read property '0' of undefined'
    // it('Should return error if array with empty object is passed in for conditions', mochaAsyncWrapper(async () => {
    //     const TEMP_SEARCH_OBJECT = TEST_SEARCH_OBJ(test_conditions1);
    //     TEMP_SEARCH_OBJECT.conditions = [{}];
    //     let err;
    //
    //     try{
    //         err = await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
    //     } catch(e) {
    //         err = e;
    //     }
    //
    //     expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    // }));

    it('Should return error if empty object is passed in for conditions', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = TEST_SEARCH_OBJ(test_conditions1);
        TEMP_SEARCH_OBJECT.conditions = {};
        let err;

        try{
            err = await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    }));

    it('Should return error if empty string is passed in for conditions', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = TEST_SEARCH_OBJ(test_conditions1);
        TEMP_SEARCH_OBJECT.conditions = '';
        let err;

        try{
            await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    }));

    it('Should return error if empty array is passed in for conditions', mochaAsyncWrapper(async () => {
        const TEMP_SEARCH_OBJECT = TEST_SEARCH_OBJ(test_conditions1);
        TEMP_SEARCH_OBJECT.conditions = [];
        let err;

        try{
            await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
        } catch(e) {
            err = e;
        }

        expect(err.message).to.equal(ERR_MSGS.CONDITIONS);
    }));

    // TODO: fix error handling here - currently returning 'Cannot read property 'dev' of undefined'
    // it('Should return error if empty string is passed in for get_attributes', mochaAsyncWrapper(async () => {
    //     const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
    //     TEMP_SEARCH_OBJECT.get_attributes = "";
    //     let err;
    //
    //     try{
    //         err = await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
    //     } catch(e) {
    //         err = e;
    //     }
    //
    //     expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
    // }));

    // TODO: fix error handling here - nothing is returned in this scenario
    // it('Should return error if empty array is passed in for get_attributes', mochaAsyncWrapper(async () => {
    //     const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ(test_conditions1));
    //     TEMP_SEARCH_OBJECT.get_attributes = [];
    //     let err;
    //
    //     try{
    //         err = await heSearchByConditions_rw(TEMP_SEARCH_OBJECT);
    //     } catch(e) {
    //         err = e;
    //     }
    //
    //     expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
    // }));
});
