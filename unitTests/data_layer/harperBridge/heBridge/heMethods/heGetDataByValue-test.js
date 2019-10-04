// 'use strict';
//
// const test_utils = require('../../../../test_utils');
// test_utils.preTestPrep();
//
// const harperdb_helium = require('../../../../../dependencies/harperdb_helium/hdb').default;
// global.hdb_helium = new harperdb_helium(false);
//
// const rewire = require('rewire');
// const heGetDataByValue_rw = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByValue');
// const heGenerateDataStoreName = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heGenerateDataStoreName');
// const evaluateTableGetAttributes = require('../../../../../data_layer/harperBridge/bridgeUtility/evaluateTableGetAttributes');
//
// const chai = require('chai');
// const sinon = require('sinon');
// const { expect } = chai;
// let sandbox;
// let heSearchReturnData_stub;
// let heSearchReturnErr_stub;
// let search_validator_rw;
// let evaluateTableGetAttributes_stub;
// let heGenerateDataStoreName_stub;
// let consolidateValueSearchData_stub;
// let consolidateValueSearchData_rw;
//
// const { TEST_DATA_DOG } = require('../../../../test_data');
// const TEST_SCHEMA = 'dev';
// const TEST_TABLE_DOG = 'dog';
//
// let test_he_return;
// let test_expected_result = {};
// let test_hash_values = [];
// let test_attr_names;
// let test_datastores;
//
// const TEST_SEARCH_OBJ = {
//     operation: "search_by_hash",
//     schema: TEST_SCHEMA,
//     table: TEST_TABLE_DOG,
//     hash_values: test_hash_values,
//     get_attributes: "*"
// };
//
// const ERR_MSGS = {
//     SCHEMA: "Schema can't be blank",
//     TABLE: "Table can't be blank",
//     HASHES: "Hash values can't be blank",
//     GET_ATTR: "Get attributes can't be blank"
// }
//
// function setupTestData() {
//     const test_data = test_utils.deepClone(TEST_DATA_DOG);
//     test_data.forEach(row => {
//         test_expected_result[row.id] = Object.assign(row, {test_null_attr: null});
//     });
//     test_attr_names = Object.keys(test_data[0]);
//     test_he_return = test_data.reduce((acc, row, i) => {
//         test_hash_values.push(row.id);
//         const row_data = []
//         row_data.push(row.id);
//         row_data.push([]);
//         test_attr_names.forEach(key => {
//             row_data[1].push(row[key]);
//         });
//         acc.push(row_data);
//         return acc;
//     }, []);
//     test_datastores = test_attr_names.map(attr => heGenerateDataStoreName(TEST_SCHEMA, TEST_TABLE_DOG, attr));
// }
//
// function setupInitialTestSpies() {
//     sandbox = sinon.createSandbox();
//     heSearchReturnData_stub = sandbox.stub().returns(test_he_return);
//     heGetDataByValue_rw.__set__('hdb_helium', {searchByValues: heSearchReturnData_stub, searchByValueRange: heSearchReturnData_stub});
//
//     search_validator_rw = heGetDataByValue_rw.__get__('search_validator');
//     evaluateTableGetAttributes_stub = sandbox.stub().callsFake(evaluateTableGetAttributes);
//     heGenerateDataStoreName_stub = sandbox.stub().callsFake(heGenerateDataStoreName);
//     consolidateValueSearchData_rw = heGetDataByValue_rw.__get__('consolidateValueSearchData');
//     consolidateValueSearchData_stub = sandbox.stub().callsFake(consolidateValueSearchData_rw);
//
//     heGetDataByValue_rw.__set__('evaluateTableGetAttributes', evaluateTableGetAttributes_stub);
//     heGetDataByValue_rw.__set__('heGenerateDataStoreName', heGenerateDataStoreName_stub);
//     heGetDataByValue_rw.__set__('consolidateValueSearchData', consolidateValueSearchData_stub);
// }
//
// describe('Test for Helium method heGetDataByValue', () => {
//
//     before(() => {
//         setupTestData();
//         setupInitialTestSpies();
//         global.hdb_schema = {
//             [TEST_SCHEMA]: {
//                 [TEST_TABLE_DOG]: {
//                     schema: TEST_SCHEMA,
//                     name: TEST_TABLE_DOG,
//                     attributes: [{attribute: 'age'}, {attribute: 'breed'}, {attribute: 'id'}, {attribute: 'name'}, {attribute: 'test_null_attr'}]
//                 }
//             },
//         };
//     });
//
//     afterEach(() => {
//         sandbox.resetHistory();
//     })
//
//     after(() => {
//         sandbox.restore();
//         rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByValue');
//         global.harperdb_helium = undefined;
//     });
//
//     it('Should consolidate final search data into an object of row data objects', () => {
//         let test_search_result;
//         try {
//             test_search_result = heGetDataByValue_rw(TEST_SEARCH_OBJ);
//         } catch(e){
//             console.log(e);
//         }
//
//         expect(test_search_result).to.deep.equal(test_expected_result);
//     });
//
//     it('Should generate a datastore name for each get_attribute', () => {
//         try {
//             heGetDataByValue_rw(TEST_SEARCH_OBJ);
//         } catch(e){
//             console.log(e);
//         }
//
//         expect(heGenerateDataStoreName_stub.callCount).to.equal(test_attr_names.length);
//     });
//
//     describe('consolidateSearchData tests', () => {
//         it('Should consolidate results from helium into object of row objects', () => {
//             let test_search_result;
//             try {
//                 test_search_result = consolidateValueSearchData_rw(test_attr_names, test_he_return);
//             } catch(err) {
//                 console.log(err);
//             }
//
//             expect(test_search_result).to.deep.equal(test_expected_result);
//         });
//     })
//
//     describe('Exception tests',() => {
//
//         it('Should return validation error',() => {
//             const validation_error = 'Validation error message';
//             heGetDataByValue_rw.__set__('search_validator', () => new Error(validation_error));
//
//             let test_search_result;
//             try {
//                 heGetDataByValue_rw(TEST_SEARCH_OBJ);
//             } catch(err) {
//                 test_search_result = err;
//             }
//
//             expect(test_search_result.message).to.equal(validation_error);
//
//             heGetDataByValue_rw.__set__('search_validator', search_validator_rw);
//         });
//
//         it('Should catch an error if helium throws one',() => {
//             const search_err_msg = 'This is an error msg';
//             heSearchReturnErr_stub = sandbox.stub().throws(new Error(search_err_msg));
//             heGetDataByValue_rw.__set__('hdb_helium', {searchByValues: heSearchReturnErr_stub, searchByValueRange: heSearchReturnErr_stub});
//
//             let test_search_result;
//             try {
//                 heGetDataByValue_rw(TEST_SEARCH_OBJ);
//             } catch(err) {
//                 test_search_result = err;
//             }
//
//             expect(test_search_result.message).to.equal(search_err_msg);
//
//             heGetDataByValue_rw.__set__('hdb_helium', {searchByValues: heSearchReturnData_stub, searchByValueRange: heSearchReturnData_stub});
//         });
//     })
// });
//
//
// // 'use strict';
// //
// //
// // const heGetDataByValue = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heGetDataByValue');
// //
// // const chai = require('chai');
// // const { expect } = chai;
// //
// //
// //
// // describe('Tests for Helium method heDropAttribute', () => {
// //
// //     before(() => {
// //         global.hdb_schema = {
// //             dev: {
// //                 dog: {
// //                     hash_attribute: "id",
// //                     schema: "dev",
// //                     name: "dog",
// //                     attributes: [{attribute: 'age'}, {attribute: 'breed'}, {attribute: 'id'}, {attribute: 'name'}]
// //                 }
// //             },
// //         };
// //     });
// //
// //     it('testing 123', () => {
// //         const TEST_SEARCH_OBJ = {
// //             operation: "search_by_value",
// //             schema: "dev",
// //             table: "dog",
// //             search_value: "*",
// //             search_attribute: "age",
// //             get_attributes: ["*"]
// //         };
// //         const test_results = heGetDataByValue(TEST_SEARCH_OBJ)
// //         expect(test_results).to.equal({});
// //     })
// // });