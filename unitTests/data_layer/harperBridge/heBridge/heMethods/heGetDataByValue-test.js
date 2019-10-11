'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const harperdb_helium = require('../../../../../dependencies/harperdb_helium/hdb').default;
global.hdb_helium = new harperdb_helium(false);

const rewire = require('rewire');
const heGetDataByValue_rw = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByValue');
const heGenerateDataStoreName = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heGenerateDataStoreName');
const evaluateTableGetAttributes = require('../../../../../data_layer/harperBridge/bridgeUtility/evaluateTableGetAttributes');
const hdb_terms = require('../../../../../utility/hdbTerms');

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
let sandbox;
let heSearchReturnData_stub;
let heSearchRangeReturnData_stub;
let heSearchReturnErr_stub;
let search_validator_rw;
let evaluateTableGetAttributes_stub;
let heGenerateDataStoreName_stub;
let consolidateValueSearchData_stub;
let consolidateValueSearchData_rw;
let generateSearchPattern_orig;
let generateFinalSearchString_orig;
let generateSearchPattern_stub;
let generateFinalSearchString_stub;

const { TEST_DATA_DOG } = require('../../../../test_data');
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';
let TEST_SEARCH_ATTR = 'breed';
const TEST_SEARCH_VALUE = 'Pit';

let test_he_return;
let test_expected_result = {};
let test_hash_values = [];
let test_attr_names;
let test_datastores;

const TEST_SEARCH_OBJ = {
    operation: "search_by_value",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    search_attribute: TEST_SEARCH_ATTR,
    search_value: TEST_SEARCH_VALUE,
    get_attributes: "*"
};

const ERR_MSGS = {
    SCHEMA: "Schema can't be blank",
    TABLE: "Table can't be blank",
    S_ATTR: "Search attribute can't be blank",
    S_VAL: "Search value can't be blank",
    GET_ATTR: "Get attributes can't be blank"
}

function setupTestData() {
    const test_data = test_utils.deepClone(TEST_DATA_DOG);
    test_data.forEach(row => {
        test_expected_result[row.id] = Object.assign(row, {test_null_attr: null});
    });
    test_attr_names = Object.keys(test_data[0]);
    test_he_return = test_data.reduce((acc, row, i) => {
        test_hash_values.push(row.id);
        const row_data = [];
        row_data.push(row.id);
        row_data.push([row.id]);
        test_attr_names.forEach(key => {
            row_data[1].push(row[key]);
        });
        acc.push(row_data);
        return acc;
    }, []);
    test_datastores = test_attr_names.map(attr => heGenerateDataStoreName(TEST_SCHEMA, TEST_TABLE_DOG, attr));
}

function setupInitialTestSpies() {
    sandbox = sinon.createSandbox();
    heSearchReturnData_stub = sandbox.stub().returns(test_utils.deepClone(test_he_return));
    heSearchRangeReturnData_stub = sandbox.stub().returns(test_utils.deepClone(test_he_return));
    heGetDataByValue_rw.__set__('hdb_helium', {searchByValues: heSearchReturnData_stub, searchByValueRange: heSearchRangeReturnData_stub});

    search_validator_rw = heGetDataByValue_rw.__get__('search_validator');
    evaluateTableGetAttributes_stub = sandbox.stub().callsFake(evaluateTableGetAttributes);
    heGenerateDataStoreName_stub = sandbox.stub().callsFake(heGenerateDataStoreName);
    consolidateValueSearchData_rw = heGetDataByValue_rw.__get__('consolidateValueSearchData');
    consolidateValueSearchData_stub = sandbox.stub().callsFake(consolidateValueSearchData_rw);
    generateSearchPattern_orig = heGetDataByValue_rw.__get__('generateSearchPattern');
    generateFinalSearchString_orig = heGetDataByValue_rw.__get__('generateFinalSearchString');
    generateSearchPattern_stub = sandbox.spy(generateSearchPattern_orig);
    generateFinalSearchString_stub = sandbox.spy(generateFinalSearchString_orig);

    heGetDataByValue_rw.__set__('evaluateTableGetAttributes', evaluateTableGetAttributes_stub);
    heGetDataByValue_rw.__set__('heGenerateDataStoreName', heGenerateDataStoreName_stub);
    heGetDataByValue_rw.__set__('consolidateValueSearchData', consolidateValueSearchData_stub);
    heGetDataByValue_rw.__set__('generateSearchPattern', generateSearchPattern_stub);
    heGetDataByValue_rw.__set__('generateFinalSearchString', generateFinalSearchString_stub);
}

describe('Test for Helium method heGetDataByValue', () => {

    before(() => {
        setupTestData();
        setupInitialTestSpies();
        global.hdb_schema = {
            [TEST_SCHEMA]: {
                [TEST_TABLE_DOG]: {
                    schema: TEST_SCHEMA,
                    name: TEST_TABLE_DOG,
                    hash_attribute: HASH_ATTRIBUTE,
                    attributes: [{attribute: 'age'}, {attribute: 'breed'}, {attribute: 'id'}, {attribute: 'name'}, {attribute: 'test_null_attr'}]
                }
            },
        };
    });

    afterEach(() => {
        sandbox.resetHistory();
    })

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByValue');
        global.harperdb_helium = undefined;
    });

    it('Should consolidate final search data into an object of row data objects', () => {
        let test_search_result;
        try {
            test_search_result = heGetDataByValue_rw(TEST_SEARCH_OBJ);
        } catch(e){
            console.log(e);
        }

        expect(test_search_result).to.deep.equal(test_expected_result);
    });

    it('Should call he.searchByValues if no * is included in search_value', () => {
        try {
            heGetDataByValue_rw(TEST_SEARCH_OBJ);
        } catch(e){
            console.log(e);
        }

        expect(heSearchReturnData_stub.called).to.equal(true);
        expect(heSearchReturnData_stub.args[0][1]).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.EXACT);
    });

    it('Should call he.searchByValueRange if * is passed in as search_value', () => {
        const search_obj = test_utils.deepClone(TEST_SEARCH_OBJ);
        search_obj.search_value = '*';
        try {
            heGetDataByValue_rw(search_obj);
        } catch(e){
            console.log(e);
        }

        expect(heSearchRangeReturnData_stub.called).to.equal(true);
        expect(heSearchRangeReturnData_stub.args[0][1]).to.equal(hdb_terms.HELIUM_VALUE_RANGE_SEARCH_OPS.GREATER_OR_EQ);
    });

    it('Should call he.searchByValues if search_value starts with *', () => {
        const search_obj = test_utils.deepClone(TEST_SEARCH_OBJ);
        search_obj.search_value = '*Sam';
        try {
            heGetDataByValue_rw(search_obj);
        } catch(e){
            console.log(e);
        }

        expect(heSearchReturnData_stub.called).to.equal(true);
        expect(heSearchReturnData_stub.args[0][1]).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.ENDS_WITH);
    });

    it('Should call he.searchByValues if search_value ends with *', () => {
        const search_obj = test_utils.deepClone(TEST_SEARCH_OBJ);
        search_obj.search_value = 'Sam*';
        try {
            heGetDataByValue_rw(search_obj);
        } catch(e){
            console.log(e);
        }

        expect(heSearchReturnData_stub.called).to.equal(true);
        expect(heSearchReturnData_stub.args[0][1]).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.STARTS_WITH);
    });

    it('Should call he.searchByValues if search_value starts and ends with *', () => {
        const search_obj = test_utils.deepClone(TEST_SEARCH_OBJ);
        search_obj.search_value = '*Sam*';
        try {
            heGetDataByValue_rw(search_obj);
        } catch(e){
            console.log(e);
        }

        expect(heSearchReturnData_stub.called).to.equal(true);
        expect(heSearchReturnData_stub.args[0][1]).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.INCLUDES);
    });

    it('Should generate a datastore name for all get_attribute plus the valueStore and the hash data store', () => {
        try {
            heGetDataByValue_rw(TEST_SEARCH_OBJ);
        } catch(e){
            console.log(e);
        }

        expect(heGenerateDataStoreName_stub.callCount).to.equal(test_attr_names.length+2);
    });

    it('Should generate a datastore name for specified get_attribute plus the valueStore and the hash data store', () => {
        const search_obj = test_utils.deepClone(TEST_SEARCH_OBJ);
        search_obj.get_attributes = ['name'];
        try {
            heGetDataByValue_rw(search_obj);
        } catch(e){
            console.log(e);
        }

        expect(heGenerateDataStoreName_stub.callCount).to.equal(search_obj.get_attributes.length+2);
    });

    describe('consolidateSearchData tests', () => {
        it('Should consolidate results from helium into object of row objects', () => {
            const test_attr_keys = [HASH_ATTRIBUTE, ...test_attr_names];
            const test_attr_values = test_utils.deepClone(test_he_return);
            let test_search_result;
            try {
                test_search_result = consolidateValueSearchData_rw(test_attr_keys, test_attr_values);
            } catch(err) {
                console.log(err);
            }

            expect(test_search_result).to.deep.equal(test_expected_result);
        });
    });

    describe('generateSearchPattern tests', () => {
        let generateSearchPattern_rw;
        let generateFinalSearchString_rw;

        before(() => {
            generateSearchPattern_rw = heGetDataByValue_rw.__get__("generateSearchPattern");
            generateFinalSearchString_rw = heGetDataByValue_rw.__get__("generateFinalSearchString");
        })

        it('Should remove * from start and end of string', () => {
            const test_string = "*blahblah*";
            const test_result = generateSearchPattern_rw(test_string);

            expect(test_result.is_range_search).to.equal(false);
            expect(test_result.search_value).to.equal("blahblah");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.INCLUDES);
        });

        it('Should not remove * if inside string', () => {
            const test_string = "blah*blah";
            const test_result = generateSearchPattern_rw(test_string, );

            expect(test_result.is_range_search).to.equal(false);
            expect(test_result.search_value).to.equal(test_string);
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.EXACT);
        });

        it('Should not remove * if inside string w/ * or % at start/end', () => {
            const test_string = "*blah*blah%";
            const test_result = generateSearchPattern_rw(test_string, );

            expect(test_result.is_range_search).to.equal(false);
            expect(test_result.search_value).to.equal("blah*blah");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.INCLUDES);
        });

        it('Should remove * at beginning', () => {
            const test_string = "*blah*blah";
            const test_result = generateSearchPattern_rw(test_string);

            expect(test_result.is_range_search).to.equal(false);
            expect(test_result.search_value).to.equal("blah*blah");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.ENDS_WITH);
        });

        it('Should remove * at end', () => {
            const test_string = "blah*blah*";
            const test_result = generateSearchPattern_rw(test_string);

            expect(test_result.is_range_search).to.equal(false);
            expect(test_result.search_value).to.equal("blah*blah");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.STARTS_WITH);
        });

        it('Should only remove last % at end', () => {
            const test_string = "blah*blah%%";
            const test_result = generateSearchPattern_rw(test_string);

            expect(test_result.is_range_search).to.equal(false);
            expect(test_result.search_value).to.equal("blah*blah%");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_SEARCH_OPS.STARTS_WITH);
        });

        it('Should return values for searchByValueRange when * is the search_value', () => {
            const test_string = "*";
            const test_result = generateSearchPattern_rw(test_string);

            expect(test_result.is_range_search).to.equal(true);
            expect(test_result.search_value).to.equal("");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_RANGE_SEARCH_OPS.GREATER_OR_EQ);
        });

        it('Should return values for searchByValueRange when % is the search_value', () => {
            const test_string = "*";
            const test_result = generateSearchPattern_rw(test_string);

            expect(test_result.is_range_search).to.equal(true);
            expect(test_result.search_value).to.equal("");
            expect(test_result.search_operation).to.equal(hdb_terms.HELIUM_VALUE_RANGE_SEARCH_OPS.GREATER_OR_EQ);
        });
    });

    describe('Exception tests',() => {
        it('Should return validation error',() => {
            const validation_error = 'Validation error message';
            heGetDataByValue_rw.__set__('search_validator', () => new Error(validation_error));

            let test_search_result;
            try {
                heGetDataByValue_rw(TEST_SEARCH_OBJ);
            } catch(err) {
                test_search_result = err;
            }

            expect(test_search_result.message).to.equal(validation_error);

            heGetDataByValue_rw.__set__('search_validator', search_validator_rw);
        });

        it('Should catch an error if helium throws one',() => {
            const search_err_msg = 'This is an error msg';
            heSearchReturnErr_stub = sandbox.stub().throws(new Error(search_err_msg));
            heGetDataByValue_rw.__set__('hdb_helium', {searchByValues: heSearchReturnErr_stub, searchByValueRange: heSearchReturnErr_stub});

            let test_search_result;
            try {
                heGetDataByValue_rw(TEST_SEARCH_OBJ);
            } catch(err) {
                test_search_result = err;
            }

            expect(test_search_result.message).to.equal(search_err_msg);

            heGetDataByValue_rw.__set__('hdb_helium', {searchByValues: heSearchReturnData_stub, searchByValueRange: heSearchReturnData_stub});
        });

        it('Should return error if empty object is passed in', () => {
            let err;
            try{
                heGetDataByValue_rw({});
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal("Schema can't be blank,Table can't be blank,Search attribute can't be blank,Search value can't be blank,Get attributes can't be blank");
        });

        it('Should return error if empty string is passed in for schema', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.schema = "";
            let err;

            try{
                err = heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.SCHEMA);
        });

        it('Should return error if empty string is passed in for table', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.table = "";
            let err;

            try{
                err = heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.TABLE);
        });

        it('Should return error if empty string is passed in for search attribute', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.search_attribute = "";
            let err;

            try{
                err = heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.S_ATTR);
        });

        it('Should return error if empty object is passed in for search attribute', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.search_attribute = {};
            let err;

            try{
                err = heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.S_ATTR);
        });

        it('Should return error if empty string is passed in for search value', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.search_value = '';
            let err;

            try{
                heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.S_VAL);
        });

        it('Should return error if empty array is passed in for search value', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.search_value = [];
            let err;

            try{
                heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.S_VAL);
        });

        it('Should return error if empty string is passed in for get_attributes', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.get_attributes = "";
            let err;

            try{
                err = heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
        });

        it('Should return error if empty array is passed in for get_attributes', () => {
            const TEMP_SEARCH_OBJECT = test_utils.deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.get_attributes = [];
            let err;

            try{
                err = heGetDataByValue_rw(TEMP_SEARCH_OBJECT);
            } catch(e) {
                err = e;
            }

            expect(err.message).to.equal(ERR_MSGS.GET_ATTR);
        });
    })
});