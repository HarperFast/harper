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
const hdb_utils = require('../../utility/common_utils');
const sc_utils = require('../../server/socketcluster/util/socketClusterUtils');
const validator = require('../../validation/csvLoadValidator');
const insert = require('../../data_layer/insert');
const logger = require('../../utility/logging/harper_logger');
const env = require('../../utility/environment/environmentManager');
const papa_parse = require('papaparse');
const fs = require('fs-extra');
const {inspect} = require('util');

const VALID_CSV_DATA = "id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const INVALID_CSV_ID_COLUMN_NAME = "id/,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const VALID_CSV_PATH = '/tmp/csv_input_valid.csv';
const INVALID_CSV_PATH = '/tmp/csv_input_invalid_id.csv';
const EMPTY_FILE_PATH = '/tmp/empty.csv';
const HOSTED_CSV_FILE_URL = 'https://s3.amazonaws.com/complimentarydata/breeds.csv';
const MIDDLEWARE_PARSE_PARAMETERS = 'SELECT * FROM CSV(?, {headers:true, separator:","})';
const CSV_URL_TEMP_DIR = `${env.get('HDB_ROOT')}/tmp`;
const TEMP_CSV_FILE = `tempCSVURLLoad.csv`;

const BULK_LOAD_RESPONSE = {
    message: 'successfully loaded 3 of 3 records',
    number_written: '3',
    records: '3'
};

const DATA_LOAD_MESSAGE = {
    "operation":"",
    "schema":"dev",
    "table":"breed",
    "action":"insert",
    "data": ''
};

const CSV_URL_MESSAGE = {
    "operation": "csv_url_load",
    "action": "insert",
    "schema": "test",
    "table": "url_load_test",
    "csv_url": "",
};

// Used to stub the post function used to send to cluster.
function  postCSVLoadFunction_stub(orig_bulk_msg, result, orig_req) {
    return result;
}

describe('Test csvBulkLoad.js', () => {
    let call_papaparse_stub;
    let call_papaparse_rewire;
    let json_message_fake = {
        "operation": "csv_file_load",
        "action": "insert",
        "schema": "golden",
        "table": "retriever",
        "transact_to_cluster_to_cluster": "false",
        "file_path": "fake/file/path.csv",
        "data": "[{\"blah\":\"blah\"}]"
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
            console.info('parser pause');
        },
        resume: () => {
            console.info('parser resume');
        }
    };

    let insert_results_fake = {
        records: 10,
        number_written: 10
    };

    let reject_fake = (err) => {
        throw err;
    };

    describe('Test csvDataLoad', function () {
        let test_msg = undefined;
        let sandbox = sinon.createSandbox();
        let bulk_load_stub = undefined;
        let bulk_load_rewire;
        let bulk_load_stub_orig = undefined;

        before(() => {
            bulk_load_stub_orig = csv_rewire.__get__('bulkLoad');
            bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
            bulk_load_rewire = csv_rewire.__set__('bulkLoad', bulk_load_stub);
        });

        beforeEach(function () {
            test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
            test_msg.operation = hdb_terms.OPERATIONS_ENUM.csv_data_load;
            test_msg.data = VALID_CSV_DATA;
            sandbox.stub(validator, 'dataObject');
        });

        afterEach(function () {
            sandbox.restore();
            bulk_load_rewire = csv_rewire.__set__('bulkLoad', bulk_load_stub_orig);
        });

        after(() => {
            bulk_load_rewire();
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
            bulk_load_stub = sandbox.stub().returns({
                message: 'successfully loaded 1 of 1 records',
                number_written: '1',
                records: '1'
            });
            csv_rewire.__set__('bulkLoad', bulk_load_stub);
            let response = undefined;
            response = await csv_rewire.csvDataLoad(test_msg).catch((e) => {
                response = e;
            });
            assert.equal(response, 'successfully loaded 1 of 1 records', 'Did not get expected response message');
            csv_rewire.__set__('bulkLoad', bulk_load_stub_orig);
        });
    });

    describe('Test csvURLLoad function', () => {
        let sandbox = sinon.createSandbox();
        let download_csv_stub = sandbox.stub();
        let remove_dir_stub;
        let success_msg = 'Successfully loaded 77 of 77 records';
        let csv_file_load_stub = sandbox.stub().resolves(success_msg);

        before(() => {
            csv_rewire.__set__('downloadCSVFile', download_csv_stub);
            csv_rewire.__set__('csvFileLoad', csv_file_load_stub);
            remove_dir_stub = sandbox.stub(hdb_utils, 'removeDir');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test bad URL throws validation error', async () => {
            CSV_URL_MESSAGE.csv_url = "breeds.csv";
            let test_err_result = await test_utils.testError(csv_rewire.csvURLLoad(CSV_URL_MESSAGE), 'Error: Csv url is not a valid url');

            expect(test_err_result).to.be.true;
        });

        it('Test for nominal behaviour and success message is returned', async () => {
            CSV_URL_MESSAGE.csv_url = 'http://data.neo4j.com/northwind/products.csv';
            sandbox.stub(validator, 'urlObject').returns(null);
            let result = await csv_rewire.csvURLLoad(CSV_URL_MESSAGE);

            expect(result).to.equal(success_msg);
        });

    });

    describe('Test downloadCSVFile function', () => {
        let response_fake = {
            body: 'id, name \n 1, harper\n'
        };
        let downloadCSVFile_rw = csv_rewire.__get__('downloadCSVFile');
        let sandbox = sinon.createSandbox();
        let request_response_stub = sandbox.stub().resolves(response_fake);
        let validate_response_stub = sandbox.stub();
        let mk_dir_stub;
        let write_file_stub;

        before(() => {
            csv_rewire.__set__('validateResponse', validate_response_stub);
            mk_dir_stub = sandbox.stub(fs, 'mkdirp');
            write_file_stub = sandbox.stub(fs, 'writeFile');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test error is handled from request promise module', async () => {
            let error;
            try {
                await downloadCSVFile_rw('wwwwww.badurl.com');
            } catch (err) {
                error = err;
            }
            expect(error).to.be.equal('Error downloading CSV file from wwwwww.badurl.com, status code: undefined. Check the log for more information.');
        });

        it('Test for nominal behaviour, stubs are called as expected', async () => {
            csv_rewire.__set__('request_promise', request_response_stub);
            let csv_file_name = `${Date.now()}.csv`;
            await downloadCSVFile_rw('www.csv.com', csv_file_name);

            expect(mk_dir_stub).to.have.been.calledWith(CSV_URL_TEMP_DIR);
            expect(write_file_stub).to.have.been.calledWith(`${CSV_URL_TEMP_DIR}/${csv_file_name}`, response_fake.body);
        });

        it('Test that error from mkdirSync is handled correctly', async () => {
            let error_msg = 'Error creating directory';
            mk_dir_stub.throws(new Error(error_msg));
            let test_err_result = await test_utils.testError(downloadCSVFile_rw('www.csv.com'), error_msg);

            expect(test_err_result).to.be.true;
        });
    });

    describe('Test validateResponse function', () => {
        let validateResponse_rw = csv_rewire.__get__('validateResponse');
        let url_fake = 'www.csv.com';

        it('Test that bad error code is handled', () => {
            let response = {
                statusCode: 400,
                statusMessage: 'Bad request'
            };
            let error;

            try {
                validateResponse_rw(response, url_fake);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`CSV Load failed from URL: ${url_fake}, status code: ${response.statusCode}, message: ${response.statusMessage}`);
        });

        it('Test non-supported content type is handled', () => {
            let response = {
                statusCode: 200,
                headers: {
                    'content-type': 'text/html'
                }
            };
            let error;

            try {
                validateResponse_rw(response, url_fake);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`CSV Load failed from URL: ${url_fake}, unsupported content type: ${response.headers['content-type']}`);
        });

        it('Test empty response body is handled', () => {
            let response = {
                statusCode: 200,
                headers: {
                    'content-type': 'text/csv'
                }
            };
            let error;

            try {
                validateResponse_rw(response, url_fake);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal(`CSV Load failed from URL: ${url_fake}, no csv found at url`);
        });
    });

    describe('Test csvFileLoad function', () => {
        let validation_msg_stub;
        let fs_access_stub;
        let logger_error_spy;
        let sandbox = sinon.createSandbox();
        let bulk_load_result_fake = {
            records: 10,
            number_written: 10
        };

        before(() => {
            call_papaparse_stub = sandbox.stub().resolves(bulk_load_result_fake);
            call_papaparse_rewire = csv_rewire.__set__('callPapaParse', call_papaparse_stub);
        });

        beforeEach(() => {
            validation_msg_stub = sandbox.stub(validator, 'fileObject').returns('');
            fs_access_stub = sandbox.stub(fs, 'access');
            logger_error_spy = sandbox.spy(logger, 'error');
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
            expect(logger_error_spy).to.have.been.calledOnce;
        });
    });

    describe('Test validateChunk function', () => {
        let sandbox = sinon.createSandbox();
        let insert_validation_stub;
        let logger_error_spy;
        let console_info_spy;
        let validate_chunk_rewire;

        let write_object_fake = {
            operation: json_message_fake.operation,
            schema: json_message_fake.schema,
            table: json_message_fake.table,
            records: data_array_fake
        };

        before(() => {
            sandbox.restore();
            validate_chunk_rewire = csv_rewire.__get__('validateChunk');
            insert_validation_stub = sandbox.stub(insert, 'validation').resolves();
            console_info_spy = sandbox.spy(console, 'info');
            logger_error_spy = sandbox.spy(logger, 'error');
        });

        after(() => {
            sandbox.restore();
            results_fake.data = [];
        });

        it('Test validation function returns if no data', async () => {
            await validate_chunk_rewire(json_message_fake, reject_fake, results_fake, parser_fake);

            expect(console_info_spy).to.have.not.been.calledWith('parser pause');
            expect(insert_validation_stub).to.not.have.been.calledWith(write_object_fake);
        });

        it('Test parser is paused/resumed and validation called', async () => {
            results_fake.data = data_array_fake;

            await validate_chunk_rewire(json_message_fake, reject_fake, results_fake, parser_fake);

            expect(console_info_spy).to.have.been.calledWith('parser pause');
            expect(console_info_spy).to.have.been.calledWith('parser resume');
            expect(insert_validation_stub).to.have.been.calledWith(write_object_fake);
        });

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
            expect(logger_error_spy).to.have.been.calledOnce;
        });
    });

    describe('Test insertChunk function', () => {
        let sandbox = sinon.createSandbox();
        let insert_chunk_rewire;
        let call_bulk_load_rewire;
        let call_bulk_load_stub;
        let call_bulk_load_orig_stub = undefined;
        let console_info_spy;
        let logger_error_spy;
        let bulk_load_result_fake = {
            records: 7,
            number_written: 6
        };

        beforeEach(() => {
            call_bulk_load_stub = sandbox.stub().resolves(bulk_load_result_fake);
            call_bulk_load_orig_stub = csv_rewire.__get__('callBulkLoad');
            insert_chunk_rewire = csv_rewire.__get__('insertChunk');
            call_bulk_load_rewire = csv_rewire.__set__('callBulkLoad', call_bulk_load_stub);
            console_info_spy = sandbox.spy(console, 'info');
            logger_error_spy = sandbox.spy(logger, 'error');
        });

        afterEach(() => {
            sandbox.restore();
            call_bulk_load_rewire();
            csv_rewire.__set__('callBulkLoad', call_bulk_load_orig_stub);
        });

        it('Test validation function returns if no data', async () => {
            await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake, parser_fake);

            expect(console_info_spy).to.have.not.been.calledWith('parser pause');
            expect(call_bulk_load_stub).to.have.not.been.calledWith('parser pause');
        });

        it('Test parser is paused/resumed and callBulkLoad is called', async () => {
            results_fake.data = data_array_fake;
            results_fake.meta = {};
            results_fake.meta.fields = ["Column 1", "Column 2"];
            await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake, parser_fake);

            expect(console_info_spy).to.have.been.calledWith('parser pause');
            expect(console_info_spy).to.have.been.calledWith('parser resume');
            expect(call_bulk_load_stub).to.have.been.calledOnce;
            expect(insert_results_fake.records).to.equal(17);
            expect(insert_results_fake.number_written).to.equal(16);
        });

        it('Test error is logged and reject promise returned', async () => {
            call_bulk_load_stub.throws(new Error('Bulk load error'));
            let error;
            let results_fake_clone = test_utils.deepClone(results_fake);
            results_fake_clone.data.push({blah: "blah"});
            try {
                await insert_chunk_rewire(json_message_fake, insert_results_fake, reject_fake, results_fake_clone, parser_fake);
            } catch(err) {
                error = err;
            }

            expect(error).to.be.instanceof(Error);
            expect(error.message).to.equal('Bulk load error');
        });
    });

    describe('Test callPapaParse function', () => {
        let sandbox = sinon.createSandbox();
        let fs_create_read_stream_stub;
        let papaparse_parse_stub;
        let logger_error_stub;
        let parse_results_fake = {
            records: 0,
            number_written: 0
        };
        let stream_fake = {
            setEncoding: () => {},
            destroy: () => {}
        };

        before(() => {
            fs_create_read_stream_stub = sandbox.stub(fs, 'createReadStream').returns(stream_fake);
            papaparse_parse_stub = sandbox.stub(papa_parse, 'parsePromise');
            logger_error_stub = sandbox.stub(logger, 'error');
            call_papaparse_rewire = csv_rewire.__get__('callPapaParse');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test readstream and papaparse are called and insert resutls are returned', async () => {
            let results = await call_papaparse_rewire(json_message_fake);

            expect(fs_create_read_stream_stub).to.have.been.calledTwice;
            expect(papaparse_parse_stub).to.have.been.calledTwice;
            expect(results).to.eql(parse_results_fake);
        });

        it('Test that error is logged and thrown', async () => {
            fs_create_read_stream_stub.throws(new Error('Argh im broken'));
            let error;

            try {
                await call_papaparse_rewire(json_message_fake);
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal('Argh im broken');
            expect(error).to.be.instanceof(Error);
            expect(logger_error_stub).to.have.been.calledOnce;
        });
    });

    describe('Test bulkLoad function', async () => {
        let sandbox = sinon.createSandbox();
        let insert_insert_stub;
        let insert_update_stub;
        let bulk_load_rewire;
        let schema_fake = 'golden';
        let table_fake = 'retriever';
        let insert_response_fake = {
            inserted_hashes: [1, 2, 3, 4, 5]
        };
        let update_response_fake = {
            update_hashes: [23, 34, 45]
        };

        before(() => {
            insert_insert_stub = sandbox.stub(insert, 'insert').resolves(insert_response_fake);
            insert_update_stub = sandbox.stub(insert, 'update').resolves(update_response_fake);
            bulk_load_rewire = csv_rewire.__get__('bulkLoad');
        });

        after(() => {
            sandbox.restore();
        });

        it('Test action defaults to insert and correct results are returned', async () => {
            let expected_result = {
                records: 2,
                number_written: 5,
                new_attributes: undefined
            };

            let result = await bulk_load_rewire(data_array_fake, schema_fake, table_fake, '');
            console.log(inspect(result));
            expect(result).to.eql(expected_result);
            expect(insert_insert_stub).to.have.been.calledOnce;
        });

        it('Test update is called and returned result is correct', async () => {
            let expected_result = {
                records: 2,
                number_written: 3,
                new_attributes: undefined
            };

            let result = await bulk_load_rewire(data_array_fake, schema_fake, table_fake, 'update');

            expect(result).to.eql(expected_result);
            expect(insert_update_stub).to.have.been.calledOnce;
        });

        it('Test insert error caught and thrown', async () => {
            insert_insert_stub.throws(new Error('Somethings wrong'));
            let error;

            try {
                await bulk_load_rewire(data_array_fake, schema_fake, table_fake, 'insert');
            } catch(err) {
                error = err;
            }

            expect(error.message).to.equal('Somethings wrong');
            expect(error).to.be.instanceof(Error);
        });
    });

    describe('test postCSVLoadFunction', async () => {
        let sandbox = sinon.createSandbox();
        let post_to_cluster_stub = undefined;
        let concat_message_stub = undefined;
        let expected_result = {
            records: 2,
            number_written: 3
        };
        let ORIGINATOR_NAME = 'somemachine';
        let postCSVLoadFunction = csv_rewire.__get__('postCSVLoadFunction');
        beforeEach(() => {
            post_to_cluster_stub = sandbox.stub(hdb_utils, `sendTransactionToSocketCluster`).returns();
            //concat_message_stub = sandbox.stub(hdb_utils, 'concatSourceMessageHeader').returns();
        });
        afterEach(() => {
            sandbox.restore();
        });
        it('nominal case, see sent to cluster', async () => {
            let msg = test_utils.deepClone(json_message_fake);
            msg.transact_to_cluster = true;
            let msg_with_originator = test_utils.deepClone(json_message_fake);
            msg_with_originator.__originator = {ORIGINATOR_NAME: 111};
            let result = postCSVLoadFunction(["blah"], msg, expected_result, msg_with_originator );
            assert.strictEqual(post_to_cluster_stub.calledOnce, true, 'expected sendTranaction to be called');
        });
        it('nominal case, see not sent to cluster', async () => {
            let msg = test_utils.deepClone(json_message_fake);
            msg.transact_to_cluster = false;
            let msg_with_originator = test_utils.deepClone(json_message_fake);
            msg_with_originator.__originator = {ORIGINATOR_NAME: 111};
            let result = postCSVLoadFunction(msg, expected_result, msg_with_originator );
            assert.strictEqual(post_to_cluster_stub.calledOnce, false, 'expected sendTranaction to NOT be called');
        });
        it('Undefined transact flag, see not sent to cluster', async () => {
            let msg = test_utils.deepClone(json_message_fake);
            msg.transact_to_cluster = undefined;
            let msg_with_originator = test_utils.deepClone(json_message_fake);
            msg_with_originator.__originator = {ORIGINATOR_NAME: 111};
            let result = postCSVLoadFunction(msg, expected_result, msg_with_originator );
            assert.strictEqual(post_to_cluster_stub.calledOnce, false, 'expected sendTranaction to NOT be called');
        });
        it('Completely missing transact flag, see not sent to cluster', async () => {
            let msg = test_utils.deepClone(json_message_fake);
            delete msg.transact_to_cluster;
            let msg_with_originator = test_utils.deepClone(json_message_fake);
            msg_with_originator.__originator = {ORIGINATOR_NAME: 111};
            let result = postCSVLoadFunction(msg, expected_result, msg_with_originator );
            assert.strictEqual(post_to_cluster_stub.calledOnce, false, 'expected sendTranaction to NOT be called');
        });
    });
});
