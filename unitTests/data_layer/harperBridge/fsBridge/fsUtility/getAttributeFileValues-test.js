'use strict';

const test_utils = require('../../../../test_utils');
const {
    createMockFS,
    deepClone,
    getMockFSPath,
    mochaAsyncWrapper,
    tearDownMockFS,
    preTestPrep
} = test_utils;
preTestPrep();

const rewire = require('rewire');
let getAttributeFileValues_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAttributeFileValues');
const fs = require('fs-extra');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');

const { TEST_DATA_DOG } = require('../../../../test_data');
const TEST_SCHEMA = 'dev';
const HASH_ATTRIBUTE = 'id';
const TEST_TABLE_DOG = 'dog';

let test_data_dog;
let test_hash_values = [];
let test_attr_names;

const TEST_SEARCH_OBJ = {
    operation: "search_by_hash",
    schema: TEST_SCHEMA,
    table: TEST_TABLE_DOG,
    hash_values: test_hash_values,
    get_attributes: "*"
};

let sandbox;
let readAttributeFiles_rw;
let readAttributeFiles_spy;
let readAttributeFilePromise_rw;
let readAttributeFilePromise_spy;

function setupTestData() {
    const test_data = deepClone(TEST_DATA_DOG);
    test_attr_names = Object.keys(test_data[0]);
    test_data_dog = test_data.reduce((acc, row) => {
        acc[row.id] = row;
        if (row.id < 4) {
            test_hash_values.push(row.id);
        }
        return acc;
    }, {});
    createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data);
}

function setupTestSpies() {
    sandbox = sinon.createSandbox()
    readAttributeFiles_rw = getAttributeFileValues_rw.__get__('readAttributeFiles');
    readAttributeFiles_spy = sandbox.spy(readAttributeFiles_rw);
    getAttributeFileValues_rw.__set__('readAttributeFiles', readAttributeFiles_spy);
    readAttributeFilePromise_rw = getAttributeFileValues_rw.__get__('readAttributeFilePromise');
    readAttributeFilePromise_spy = sandbox.spy(readAttributeFilePromise_rw);
    getAttributeFileValues_rw.__set__('readAttributeFilePromise', readAttributeFilePromise_spy);
}

describe('getAttributeFileValues', () => {


    before(() => {
        setupTestData();
        setupTestSpies();
        getAttributeFileValues_rw.__set__('getBasePath', getMockFSPath);
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    after(() => {
        tearDownMockFS();
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsUtility/getAttributeFileValues');
    });

    it('Should return all get_attr data for hashes in search_object', mochaAsyncWrapper(async () => {
        const test_result = await getAttributeFileValues_rw(test_attr_names, TEST_SEARCH_OBJ);

        const test_result_keys = Object.keys(test_result);
        expect(test_result_keys.length).to.equal(test_attr_names.length);
        expect(test_result_keys.sort()).to.deep.equal(test_attr_names.sort());
    }));

    it('Should call readAttributeFiles() for each get_attr passed in', mochaAsyncWrapper(async () => {
        await getAttributeFileValues_rw(test_attr_names, TEST_SEARCH_OBJ);

        expect(readAttributeFiles_spy.callCount).to.equal(test_attr_names.length);
    }));

    it('Should catch and throw an error if readAttributeFiles() throws an error', mochaAsyncWrapper(async () => {
        const error_msg = "Read error!";
        const readAttributeFiles_stub = sinon.stub().throws(new Error(error_msg));
        getAttributeFileValues_rw.__set__('readAttributeFiles', readAttributeFiles_stub);

        let test_results;
        try {
            test_results = await getAttributeFileValues_rw(test_attr_names, TEST_SEARCH_OBJ);
        } catch(e) {
            expect(e.message).to.equal(error_msg);
        }

        expect(readAttributeFiles_stub.callCount).to.equal(1);
        expect(test_results).to.equal(undefined);
        getAttributeFileValues_rw.__set__('readAttributeFiles', readAttributeFiles_spy);
    }));

    context('Test readAttributeFilePromise function', () => {
        const test_table_path = `${getMockFSPath()}/${TEST_SCHEMA}/${TEST_TABLE_DOG}`;
        let test_attr_name;
        let test_hash_val;
        let test_attr_data = {};

        before(() => {
            test_attr_name = test_attr_names[0];
            test_hash_val = test_hash_values[0];
        });

        afterEach(() => {
            test_attr_data = {};
            getAttributeFileValues_rw.__set__('fs', fs);
        })

        it('Should push value object into attribute_data', mochaAsyncWrapper(async () => {
            await readAttributeFilePromise_rw(test_table_path, test_attr_name, test_hash_val, test_attr_data);

            const test_result_keys = Object.values(test_attr_data);
            expect(test_result_keys.length).to.equal(1);
            expect(test_attr_data[test_hash_val]).to.equal(test_data_dog[test_hash_val][test_attr_name]);
        }));

        it('Should throw an error if e.code does not equal ENOENT', mochaAsyncWrapper(async () => {
            const test_error = new Error("readFile error!");
            const error_stub = {
                readFile: () => {
                    throw test_error;
                }
            };
            getAttributeFileValues_rw.__set__('fs', error_stub);
            let test_result;
            try {
                await readAttributeFilePromise_rw(test_table_path, test_attr_name, test_hash_val, test_attr_data);
            }
            catch(e) {
                test_result = e;
            }

            expect(test_result).to.equal(test_error);
        }));

        it('Should NOT throw an error if e.code equals ENOENT', mochaAsyncWrapper(async () => {
            const test_error = new Error("readFile error!");
            test_error.code = "ENOENT";
            const error_stub = {
                readFile: () => {
                    throw test_error;
                }
            };
            getAttributeFileValues_rw.__set__('fs', error_stub );
            let test_result;

            try {
                await readAttributeFilePromise_rw(test_table_path, test_attr_name, test_hash_val, test_attr_data);
            }
            catch(e) {
                test_result = e;
            }

            expect(test_result).to.equal(undefined);
            const test_result_keys = Object.values(test_attr_data);
            expect(test_result_keys.length).to.equal(0);
        }));
    });

    context('Test readAttributeFiles function', () => {
        const test_table_path = `${getMockFSPath()}/${TEST_SCHEMA}/${TEST_TABLE_DOG}`;
        let test_attr_name;

        before(() => {
            test_attr_name = test_attr_names[0];
        });

        it('Should return an object of attr value/pairs for each hash value passed in', mochaAsyncWrapper(async () => {
            const test_results = await readAttributeFiles_rw(test_table_path, test_attr_name, test_hash_values);

            const test_result_keys = Object.keys(test_results);
            expect(test_result_keys.length).to.equal(test_hash_values.length);
            test_result_keys.forEach(hash_val => {
                expect(test_results[hash_val]).to.equal(test_data_dog[hash_val][test_attr_name]);
            });
        }));
    });
});
