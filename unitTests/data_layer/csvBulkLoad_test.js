'use strict';

const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const assert = require('assert');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const rewire = require('rewire');
let csv_rewire = rewire('../../data_layer/csvBulkLoad');
const hdb_terms = require('../../utility/hdbTerms');
const validator = require('../../validation/csvLoadValidator');
const insert = require('../../data_layer/insert');
const logger = require('../../utility/logging/harper_logger');
const fs = require('fs-extra');
const {promise} = require('alasql');

const VALID_CSV_DATA = "id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const INVALID_CSV_ID_COLUMN_NAME = "id/,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const VALID_CSV_PATH = '/tmp/csv_input_valid.csv';
const INVALID_CSV_PATH = '/tmp/csv_input_invalid_id.csv';
const EMPTY_FILE_PATH = '/tmp/empty.csv';
const HOSTED_CSV_FILE_URL = 'https://s3.amazonaws.com/complimentarydata/breeds.csv';
const MIDDLEWARE_PARSE_PARAMETERS = 'SELECT * FROM CSV(?, {headers:true, separator:","})';

const BULK_LOAD_RESPONSE = {
    message: 'successfully loaded 3 of 3 records'
};

const DATA_LOAD_MESSAGE = {
    "operation":"",
    "schema":"dev",
    "table":"breed",
    "action":"insert",
    "data": ''
};

describe('Test csvBulkLoad.js', () => {
    let json_message_fake = {
        "operation": "csv_file_load",
        "action": "insert",
        "schema": "golden",
        "table": "retriever",
        "file_path": "fake/file/path.csv"
    };
    let results_fake = {
        data: []
    };
    let data_array_fake = [
        {
            "Column 1": "foo",
            "Column 2": "bar"
        },
        {
            "Column 1": "abc",
            "Column 2": "def"
        }
    ];
    let parser_fake = {
        pause: () => {
            console.log('parser pause');
        },
        resume: () => {
            console.log('parser resume');
        }
    };

    // function reject_fake(err) {
    //     return new Promise( function (resolve, reject) {
    //        reject(err);
    //     });
    // }

    let reject_fake = (err) => {
        throw err;
    };

    describe('Test csvDataLoad', function () {
        let test_msg = undefined;
        let sandbox = sinon.createSandbox();
        let bulk_load_stub = undefined;
        beforeEach(function () {
            test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
            test_msg.operation = hdb_terms.OPERATIONS_ENUM.csv_data_load;
            test_msg.data = VALID_CSV_DATA;
            bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
            csv_rewire.__set__('bulkLoad', bulk_load_stub);
            sandbox.stub(validator, 'dataObject');
        });
        afterEach(function () {
            sandbox.restore();
        });

        it('Test csvDataLoad nominal case with valid file and valid column names/data', async function() {
            try {
                let result = await csv_rewire.csvDataLoad(test_msg);
                assert.equal(result, BULK_LOAD_RESPONSE.message, 'Got incorrect response');
            } catch(e) {
                throw e;
            }
        });
        it('Test csvDataLoad invalid column names, expect exception', async function() {
            test_msg.data = INVALID_CSV_ID_COLUMN_NAME;
            let response = undefined;
            await csv_rewire.csvDataLoad(test_msg).catch( (e) => {
                response = e;
            });
            assert.ok((response instanceof Error) === true, 'Did not get expected exception');
        });
        it('Test csvDataLoad missing data, expect exception', async function() {
            test_msg.data = null;
            let response = undefined;
            await csv_rewire.csvDataLoad(test_msg).catch( (e) => {
                response = e;
            });
            assert.ok((response instanceof Error) === true, 'Did not get expected exception');
        });
        it('Test csvDataLoad bad csv data, expect nothing loaded message' , async function() {
            test_msg.data = 'a, a a a';
            let response = undefined;
            response = await csv_rewire.csvDataLoad(test_msg).catch( (e) => {
                response = e;
            });
            assert.equal(response, 'No records parsed from csv file.', 'Did not get expected response message');
        });
        it('Test csvDataLoad incomplete csv data, expect nothing loaded message' , async function() {
            test_msg.data = 'a, b, c, d\n1,';
            bulk_load_stub = sandbox.stub().returns({message:'successfully loaded 1 of 1 records'});
            csv_rewire.__set__('bulkLoad', bulk_load_stub);
            let response = undefined;
            response = await csv_rewire.csvDataLoad(test_msg).catch( (e) => {
                response = e;
            });
            assert.equal(response, 'successfully loaded 1 of 1 records', 'Did not get expected response message');
        });
    });

    describe('Test callMiddleware', function () {
        let test_msg = undefined;
        let sandbox = sinon.createSandbox();
        let callMiddleware = csv_rewire.__get__('callMiddleware');
        let alasql_promise_stub = undefined;
        beforeEach(function () {
            test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
            test_msg.operation = hdb_terms.OPERATIONS_ENUM.csv_data_load;
            test_msg.data = VALID_CSV_DATA;

        });
        afterEach(function () {
            // Restore the promise
            csv_rewire.__set__('promise', promise);
        });
        it("test nominal case, valid inputs", async function() {
            let results = await callMiddleware(MIDDLEWARE_PARSE_PARAMETERS, VALID_CSV_DATA).catch( (e) => {
                throw e;
            });
            assert.equal(results.length, 3, "Expeted array of length 3 back");
        });
        it("Test invalid parameter", async function() {
            let results = await callMiddleware(null, VALID_CSV_DATA).catch( (e) => {
                throw e;
            });
            assert.equal(results.length, 0, "Expeted array of length 0 back");
        });
        it("Test invalid data parameter", async function() {
            let results = await callMiddleware(MIDDLEWARE_PARSE_PARAMETERS, null).catch( (e) => {
                throw e;
            });
            assert.equal(results.length, 0, "Expeted array of length 0 back");
        });
        it("Test alasql throwing exception", async function() {
            alasql_promise_stub = sandbox.stub().yields(new Error("OMG ERROR"));
            csv_rewire.__set__('promise', alasql_promise_stub);
            let excep = undefined;
            try {
                await callMiddleware(MIDDLEWARE_PARSE_PARAMETERS, VALID_CSV_DATA);
            } catch(e) {
                excep = e;
            };
            assert.equal((excep instanceof Error),true, "Expeted exception");
        });
    });

    describe('Test csvURLLoad', function () {
        let test_msg = undefined;
        let sandbox = sinon.createSandbox();
        let bulk_load_stub = undefined;
        // TODO: Expand these tests once we can get some additional invalid csv files hosted on the intranet.
        beforeEach(function () {
            test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
            test_msg.operation = hdb_terms.OPERATIONS_ENUM.csv_url_load;
            bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
            csv_rewire.__set__('bulkLoad', bulk_load_stub);
            sandbox.stub(validator, 'urlObject');
        });
        afterEach(function () {
            sandbox.restore();
        });

        it('Test csvURLLoad nominal case with valid file and valid column names/data', async function() {
            try {
                test_msg.csv_url = HOSTED_CSV_FILE_URL;
                let result = await csv_rewire.csvURLLoad(test_msg);
                assert.equal(result, BULK_LOAD_RESPONSE.message, 'Got incorrect response');
            } catch(e) {
                throw e;
            }
        });
        it('Test csvDataLoad with bad path', async function() {
            test_msg.csv_url = 'http://omgbadurlwtf/docs.csv';
            let response = undefined;
            try {
                response = await csv_rewire.csvURLLoad(test_msg);
            } catch (e) {
                response = e;
            }
            assert.ok((response instanceof Error) === true, 'Did not get expected exception');
        });
    });

    describe('Test createReadStreamFromURL', function () {
        let createReadStreamFromURL = csv_rewire.__get__('createReadStreamFromURL');

        // TODO: Expand these tests once we can get some additional invalid csv files hosted on the intranet.
        // https://harperdb.atlassian.net/browse/OPS-27
        beforeEach(function () {

        });
        afterEach(function () {

        });

        it('Test createReadStreamFromURL nominal case', async function () {
            let response = await createReadStreamFromURL(HOSTED_CSV_FILE_URL);
            assert.equal(response.statusCode, hdb_terms.HTTP_STATUS_CODES.OK, 'Expected 200 status code');
        });
    });

    describe('Test csvFileLoad function', () => {
        let validation_msg_stub;
        let fs_access_stub;
        let call_papaparse_stub;
        let call_papaparse_rewire;
        let logger_error_stub;
        let sandbox = sinon.createSandbox();
        let bulk_load_result_fake = {
            records: 10,
            number_written: 10
        };

        beforeEach(() => {
            validation_msg_stub = sandbox.stub(validator, 'fileObject').returns('');
            fs_access_stub = sandbox.stub(fs, 'access');
            call_papaparse_stub = sandbox.stub().resolves(bulk_load_result_fake);
            call_papaparse_rewire = csv_rewire.__set__('callPapaParse', call_papaparse_stub);
            logger_error_stub = sandbox.stub(logger, 'error');
        });

        afterEach(() => {
            sandbox.restore();
        });

        after(() => {
            call_papaparse_rewire();
        });

        it('Test validation throws error', async () => {
            validation_msg_stub.returns('Validation error');
            let error;

            try {
                await csv_rewire.csvFileLoad(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceof(Error);
            expect(error.message).to.equal('Validation error');
            expect(validation_msg_stub).to.have.been.calledOnce;
        });
        
        it('Test exception from fs.access is caught', async () => {
            fs_access_stub.throws(new Error('Access error'));
            let error;

            try {
                await csv_rewire.csvFileLoad(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceof(Error);
            expect(error.message).to.equal('Access error');
            expect(fs_access_stub).to.have.been.calledOnce;
        });
        
        it('Test success message is returned', async () => {
            let result = await csv_rewire.csvFileLoad(json_message_fake);

            expect(result).to.equal(`successfully loaded ${bulk_load_result_fake.number_written} of ${bulk_load_result_fake.records} records`);
            expect(call_papaparse_stub).to.have.been.calledOnce;
        });

        it('Test exception from papaparse is caught and logged', async () => {
            call_papaparse_stub.throws(new Error('Papa parse error'));
            let error;

            try {
                await csv_rewire.csvFileLoad(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceof(Error);
            expect(error.message).to.equal('Papa parse error');
            expect(logger_error_stub).to.have.been.calledOnce;
            expect(call_papaparse_stub).to.have.been.calledOnce;
        });
    });

    describe('Test validateChunk function', () => {
        let sandbox = sinon.createSandbox();
        let insert_validation_stub;
        let logger_error_stub;
        let console_log_stub;
        let validate_chunk_rewire;

        let write_object_fake = {
            operation: json_message_fake.operation,
            schema: json_message_fake.schema,
            table: json_message_fake.table,
            records: data_array_fake
        };

        before(() => {
            validate_chunk_rewire = csv_rewire.__get__('validateChunk');
            insert_validation_stub = sandbox.stub(insert, 'validation').resolves();
            console_log_stub = sandbox.stub(console, 'log');
            logger_error_stub = sandbox.stub(logger, 'error');
        });

        after(() => {
            sandbox.restore();
            results_fake.data = [];
        });

        it('Test validation function returns if no data', async () => {
           await validate_chunk_rewire(json_message_fake, reject_fake, results_fake, parser_fake);

            expect(console_log_stub).to.have.not.been.calledWith('parser pause');
            expect(insert_validation_stub).to.not.have.been.calledWith(write_object_fake);
        });

        it('Test parser is paused/resumed and validation called', async () => {
            results_fake.data = data_array_fake;

            await validate_chunk_rewire(json_message_fake, reject_fake, results_fake, parser_fake);

            expect(console_log_stub).to.have.been.calledWith('parser pause');
            expect(console_log_stub).to.have.been.calledWith('parser resume');
            expect(insert_validation_stub).to.have.been.calledWith(write_object_fake);
        });

        // TODO: Talk to Eli about this
        it('Test error is logged and reject promise returned', async () => {
            insert_validation_stub.throws(new Error('Insert error'));
            let error;

            try {
                await validate_chunk_rewire(json_message_fake, reject_fake, results_fake, parser_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceof(Error);
            expect(error.message).to.equal('Insert error');
            expect(logger_error_stub).to.have.been.calledOnce;
        });
    });

    describe('Test insertChunk function', () => {
        let sandbox = sinon.createSandbox();
        let insert_chunk_rewire;
        let call_bulk_load_rewire;
        let call_bulk_load_stub;
        let console_log_stub;
        let insert_results_fake = {
            records: 10,
            number_written: 10
        };
        let bulk_load_result_fake = {
            records: 7,
            number_written: 7
        };

        before(() => {
            call_bulk_load_stub = sandbox.stub().resolves(bulk_load_result_fake);
            insert_chunk_rewire = csv_rewire.__get__('insertChunk');
            call_bulk_load_rewire = csv_rewire.__set__('callBulkLoad', call_bulk_load_stub);
            console_log_stub = sandbox.stub(console, 'log');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test validation function returns if no data', async () => {
            await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake, parser_fake);

            expect(console_log_stub).to.have.not.been.calledWith('parser pause');
            expect(call_bulk_load_stub).to.have.not.been.calledWith('parser pause');
        });

        it('Test parser is paused/resumed and callBulkLoad is called', async () => {
            results_fake.data = data_array_fake;
            await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake, parser_fake);


            console.log('HERE' + insert_results_fake.records);

        });


    });

// describe('Test csvFileLoad', function () {
//     let test_msg = undefined;
//     let sandbox = sinon.createSandbox();
//     let bulk_load_stub = undefined;
//     before(function() {
//         fs.writeFileSync(VALID_CSV_PATH, VALID_CSV_DATA);
//         fs.writeFileSync(INVALID_CSV_PATH, INVALID_CSV_ID_COLUMN_NAME);
//         fs.writeFileSync(EMPTY_FILE_PATH, '');
//     });
//     // TODO: Expand these tests once we can get some additional invalid csv files hosted on the intranet.
//     beforeEach(function () {
//         test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
//         test_msg.operation = hdb_terms.OPERATIONS_ENUM.csv_file_load;
//         bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
//         csv_rewire.__set__('bulkLoad', bulk_load_stub);
//         sandbox.stub(validator, 'fileObject');
//     });
//     afterEach(function () {
//         sandbox.restore();
//     });
//     after(function() {
//
//     });
//
//     it('Test csvFileLoad nominal case with valid file and valid column names/data', async function () {
//         let response = undefined;
//         try {
//             test_msg.file_path = VALID_CSV_PATH;
//             let result = await csv_rewire.csvFileLoad(test_msg);
//             assert.equal(result, BULK_LOAD_RESPONSE.message, 'Got incorrect response');
//         } catch (e) {
//             throw e;
//         }
//     });
//
//     it('Test csvFileLoad invalid column names, expect exception', async function() {
//         test_msg.file_path = INVALID_CSV_PATH;
//         let response = undefined;
//         await csv_rewire.csvFileLoad(test_msg).catch( (e) => {
//             response = e;
//         });
//         assert.ok((response instanceof Error) === true, 'Did not get expected exception');
//     });
//     it('Test csvFileLoad bad file path, expect exception', async function() {
//         test_msg.file_path = '/tmp/yaddayadda.csv';
//         let response = undefined;
//         await csv_rewire.csvFileLoad(test_msg).catch( (e) => {
//             response = e;
//         });
//         assert.ok((response instanceof Error) === true, 'Did not get expected exception');
//     });
//     it('Test csvFileLoad file path to empty file, no records parsed', async function() {
//         test_msg.file_path = EMPTY_FILE_PATH;
//         let response = undefined;
//         let result = await csv_rewire.csvFileLoad(test_msg).catch( (e) => {
//             response = e;
//         });
//
//         assert.equal(result, 'No records parsed from csv file.', 'Got incorrect response' + result);
//     });
// });

    // describe('Test bulkload', () => {
    //     let sandbox = sinon.createSandbox();
    //     let bulk_load;
    //     let insert_insert_stub;
    //     let insert_update_stub;
    //     let records_fake = [{
    //         id: 1,
    //         name: 'hairy maclary'
    //     }];
    //     let schema_fake = 'houses';
    //     let table_fake = 'forDogs';
    //     let action_fake;
    //     let fake_error = 'Attribute does not exist';
    //     let write_insert_response_fake = {
    //         message: 'inserted 1 of 1 records',
    //         skipped_hashes: [],
    //         inserted_hashes: [1]
    //
    //     };
    //     let write_update_response_fake = {
    //         message: 'updated 1 of 1 records',
    //         skipped_hashes: [],
    //         update_hashes: [1]
    //     };
    //
    //     before(() => {
    //         csv_rewire = rewire('../../data_layer/csvBulkLoad');
    //         bulk_load = csv_rewire.__get__('bulkLoad');
    //         insert_insert_stub = sandbox.stub(insert, 'insert');
    //         insert_update_stub = sandbox.stub(insert, 'update');
    //     });
    //
    //     after( () => {
    //         sandbox.restore();
    //         csv_rewire = rewire('../../data_layer/csvBulkLoad');
    //     });
    //
    //     it('should successfully insert records', async () => {
    //         insert_insert_stub.resolves(write_insert_response_fake);
    //         let result = await bulk_load(records_fake, schema_fake, table_fake, action_fake);
    //
    //         assert.equal(result.message, `successfully loaded 1 of 1 records`, 'Got incorrect response ' + result.message);
    //     });
    //
    //     it('should successfully skip insert records', async () => {
    //         write_insert_response_fake.inserted_hashes = [];
    //         write_insert_response_fake.skipped_hashes = [1];
    //         insert_insert_stub.resolves(write_insert_response_fake);
    //         let result = await bulk_load(records_fake, schema_fake, table_fake, action_fake);
    //
    //         assert.equal(result.message, `successfully loaded 0 of 1 records`, 'Got incorrect response ' + result.message);
    //     });
    //
    //     it('should successfully update records', async () => {
    //         action_fake = 'update';
    //         insert_update_stub.resolves(write_update_response_fake);
    //         let result = await bulk_load(records_fake, schema_fake, table_fake, action_fake);
    //
    //         assert.equal(result.message, `successfully loaded 1 of 1 records`, 'Got incorrect response ' + result.message);
    //     });
    //
    //     it('should catch error from write_response', async () => {
    //         insert_update_stub.throws(new Error(fake_error));
    //         action_fake = 'update';
    //         let error;
    //
    //         try {
    //             await bulk_load(records_fake, schema_fake, table_fake, action_fake);
    //         } catch(err) {
    //             error = err;
    //         }
    //
    //         assert.equal(error.message, fake_error, 'Got incorrect response ' + error);
    //     });
    // });
});

