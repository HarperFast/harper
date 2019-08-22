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
let fsGetDataByHash = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByHash');
const log = require('../../../../../utility/logging/harper_logger');
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
let log_error_spy;
let getAttributeFiles_rw;
let getAttributeFiles_spy;
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
    log_error_spy = sandbox.spy(log, 'error');
    getAttributeFiles_rw = fsGetDataByHash.__get__('getAttributeFiles');
    // getAttributeFiles_spy = sandbox.spy(getAttributeFiles_rw);
    // fsGetDataByHash.__set__('getAttributeFiles', getAttributeFiles_spy);
    readAttributeFiles_rw = fsGetDataByHash.__get__('readAttributeFiles');
    readAttributeFiles_spy = sandbox.spy(readAttributeFiles_rw);
    fsGetDataByHash.__set__('readAttributeFiles', readAttributeFiles_spy);
    readAttributeFilePromise_rw = fsGetDataByHash.__get__('readAttributeFilePromise');
    readAttributeFilePromise_spy = sandbox.spy(readAttributeFilePromise_rw);
    fsGetDataByHash.__set__('readAttributeFilePromise', readAttributeFilePromise_spy);
}

describe('fsGetDataByHash', () => {


    before(() => {
        setupTestData();
        setupTestSpies();
        fsGetDataByHash.__set__('getBasePath', getMockFSPath);
    });

    afterEach(() => {
        sandbox.resetHistory();
    });

    after(() => {
        tearDownMockFS();
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsGetDataByHash');
    });

    context('Test fsGetDataByHash function', () => {

        it('Should return results for each hash value passed', mochaAsyncWrapper(async () => {
            const test_search_result = await fsGetDataByHash(TEST_SEARCH_OBJ);

            expect(Object.keys(test_search_result).length).to.equal(test_hash_values.length);
            Object.keys(test_search_result).forEach(row_id => {
                const test_hash = parseInt(row_id);
                expect(test_hash).to.equal(test_search_result[row_id].id);
                expect(test_hash_values.includes(test_hash)).to.equal(true);
            });
        }));

        it('Should return correct attributes for each hash value passed', mochaAsyncWrapper(async () => {
            const test_search_result = await fsGetDataByHash(TEST_SEARCH_OBJ);

            Object.keys(test_search_result).forEach(row_id => {
                expect(test_hash_values.includes(parseInt(row_id))).to.equal(true);
                Object.keys(test_search_result[row_id]).forEach(attr_name => {
                    expect(test_data_dog[row_id][attr_name]).to.equal(test_search_result[row_id][attr_name]);
                });
            });
        }));

        it('Should return specified attributes for each hash value passed', mochaAsyncWrapper(async () => {
            const test_attr_name = test_attr_names[0];
            const TEMP_SEARCH_OBJECT = deepClone(TEST_SEARCH_OBJ);
            TEMP_SEARCH_OBJECT.get_attributes = [test_attr_name];

            const test_search_result = await fsGetDataByHash(TEST_SEARCH_OBJ);

            expect(Object.keys(test_search_result).length).to.equal(test_hash_values.length);
            Object.keys(test_search_result).forEach(row_id => {
                Object.keys(test_search_result[row_id]).forEach(attr_name => {
                    expect(test_attr_names.includes(attr_name)).to.equal(true);
                    expect(test_search_result[row_id][attr_name]).to.equal(test_data_dog[row_id][attr_name]);
                });
            });
        }));
    });

    context('Test evaluateTableAttributes function', () => {
        let evaluateTableAttributes_rw;
        const test_global_attrs = [
            { "attribute": "age" },
            { "attribute": "breed" },
            { "attribute": "id" },
            { "attribute": "name" }
        ]
        const get_all_attrs = ["*"];

        before(() => {
            evaluateTableAttributes_rw = fsGetDataByHash.__get__('evaluateTableAttributes');
        });

        it('Should return all attr names from global schema if * is passed in',() => {
            const test_result = evaluateTableAttributes_rw(get_all_attrs, test_global_attrs);

            expect(test_result.length).to.equal(test_global_attrs.length);
            expect(test_result.sort()).to.deep.equal(test_attr_names.sort());
        });

        it('Should filter out duplicate attributes from from global schema if * is passed in',() => {
            const test_global_attrs_dups = deepClone(test_global_attrs);
            test_global_attrs_dups.push({ "attribute": "age" });
            test_global_attrs_dups.push({ "attribute": "id" });
            const test_result = evaluateTableAttributes_rw(get_all_attrs, test_global_attrs_dups);

            expect(test_result.length).to.equal(test_global_attrs.length);
            expect(test_result.sort()).to.deep.equal(test_attr_names.sort());
        });

        it('Should return get_attributes if specific values are passed in',() => {
            const test_result = evaluateTableAttributes_rw(test_attr_names, test_global_attrs);

            expect(test_result.length).to.equal(test_attr_names.length);
            expect(test_attr_names).to.equal(test_attr_names);
        });
    });

     context('Test getAttributeFiles function', () => {
        // let getAttributeFiles_rw;


        // before(() => {
        //     getAttributeFiles_rw = fsGetDataByHash.__get__('getAttributeFiles');
        // });

        it('Should return all get_attr data for hashes in search_object', mochaAsyncWrapper(async () => {
            const test_result = await getAttributeFiles_rw(test_attr_names, TEST_SEARCH_OBJ);

            const test_result_keys = Object.keys(test_result);
            expect(test_result_keys.length).to.equal(test_attr_names.length);
            expect(test_result_keys.sort()).to.deep.equal(test_attr_names.sort());
        }));

        it('Should call readAttributeFiles() for each get_attr passed in', mochaAsyncWrapper(async () => {
            await getAttributeFiles_rw(test_attr_names, TEST_SEARCH_OBJ);

            expect(readAttributeFiles_spy.callCount).to.equal(test_attr_names.length);
        }));

        it('Should catch and throw an error if readAttributeFiles() throws an error', mochaAsyncWrapper(async () => {
            const error_msg = "Read error!";
            const readAttributeFiles_stub = sinon.stub().throws(new Error(error_msg));
            fsGetDataByHash.__set__('readAttributeFiles', readAttributeFiles_stub);

            let test_results;
            try {
                test_results = await getAttributeFiles_rw(test_attr_names, TEST_SEARCH_OBJ);
            } catch(e) {
                expect(e.message).to.equal(error_msg);
            }

            expect(readAttributeFiles_stub.callCount).to.equal(1);
            expect(test_results).to.equal(undefined);
            fsGetDataByHash.__set__('readAttributeFiles', readAttributeFiles_spy);
        }));
     });

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
            fsGetDataByHash.__set__('fs', fs);
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
            fsGetDataByHash.__set__('fs', error_stub);
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
            fsGetDataByHash.__set__('fs', error_stub );
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

        afterEach(() => {
            fsGetDataByHash.__set__('fs', fs);
        })

        it('Should create promise', mochaAsyncWrapper(async () => {
            await readAttributeFilePromise_rw(test_table_path, test_attr_name, test_hash_val, test_attr_data);

            const test_result_keys = Object.values(test_attr_data);
            expect(test_result_keys.length).to.equal(1);
            expect(test_attr_data[test_hash_val]).to.equal(test_data_dog[test_hash_val][test_attr_name]);
        }));
    });


});
