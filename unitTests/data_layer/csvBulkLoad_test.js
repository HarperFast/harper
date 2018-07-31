'use strict';

const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const csv_rewire = rewire('../../data_layer/csvBulkLoad');
const hdb_terms = require('../../utility/hdbTerms');
const fs = require('fs');
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

describe('Test csvDataLoad', function () {
    let test_msg = undefined;
    let sandbox = sinon.createSandbox();
    let bulk_load_stub = undefined;
    beforeEach(function () {
        test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
        test_msg.operation = hdb_terms.OPERATION_NAMES.csv_data_load;
        test_msg.data = VALID_CSV_DATA;
        bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
        csv_rewire.__set__('p_bulk_load', bulk_load_stub);
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
        csv_rewire.__set__('p_bulk_load', bulk_load_stub);
        let response = undefined;
        response = await csv_rewire.csvDataLoad(test_msg).catch( (e) => {
            response = e;
        });
        assert.equal(response, 'successfully loaded 1 of 1 records', 'Did not get expected response message');
    });
});

describe('Test makeMiddlewareCall', function () {
    let test_msg = undefined;
    let sandbox = sinon.createSandbox();
    let makeMiddlewareCall = csv_rewire.__get__('makeMiddlewareCall');
    let alasql_promise_stub = undefined;
    beforeEach(function () {
        test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
        test_msg.operation = hdb_terms.OPERATION_NAMES.csv_data_load;
        test_msg.data = VALID_CSV_DATA;

    });
    afterEach(function () {
        // Restore the promise
        csv_rewire.__set__('promise', promise);
    });
    it("test nominal case, valid inputs", async function() {
        let results = await makeMiddlewareCall(MIDDLEWARE_PARSE_PARAMETERS, VALID_CSV_DATA).catch( (e) => {
            throw e;
        });
        assert.equal(results.length, 3, "Expeted array of length 3 back");
    });
    it("Test invalid parameter", async function() {
        let results = await makeMiddlewareCall(null, VALID_CSV_DATA).catch( (e) => {
            throw e;
        });
        assert.equal(results.length, 0, "Expeted array of length 0 back");
    });
    it("Test invalid data parameter", async function() {
        let results = await makeMiddlewareCall(MIDDLEWARE_PARSE_PARAMETERS, null).catch( (e) => {
            throw e;
        });
        assert.equal(results.length, 0, "Expeted array of length 0 back");
    });
    it("Test alasql throwing exception", async function() {
        alasql_promise_stub = sandbox.stub().yields(new Error("OMG ERROR"));
        csv_rewire.__set__('promise', alasql_promise_stub);
        let excep = undefined;
        try {
            await makeMiddlewareCall(MIDDLEWARE_PARSE_PARAMETERS, VALID_CSV_DATA);
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
        test_msg.operation = hdb_terms.OPERATION_NAMES.csv_url_load;
        bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
        csv_rewire.__set__('p_bulk_load', bulk_load_stub);
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('Test csvDataLoad nominal case with valid file and valid column names/data', async function() {
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

    })

    it('Test createReadStreamFromURL nominal case', async function () {
        let response = await createReadStreamFromURL(HOSTED_CSV_FILE_URL);
        assert.equal(response.statusCode, hdb_terms.HTTP_STATUS_CODES.OK, 'Expected 200 status code');
    });
});

describe('Test csvFileLoad', function () {
    let test_msg = undefined;
    let sandbox = sinon.createSandbox();
    let bulk_load_stub = undefined;
    before(function() {
        fs.writeFileSync(VALID_CSV_PATH, VALID_CSV_DATA);
        fs.writeFileSync(INVALID_CSV_PATH, INVALID_CSV_ID_COLUMN_NAME);
        fs.writeFileSync(EMPTY_FILE_PATH, '');
    });
    // TODO: Expand these tests once we can get some additional invalid csv files hosted on the intranet.
    beforeEach(function () {
        test_msg = test_utils.deepClone(DATA_LOAD_MESSAGE);
        test_msg.operation = hdb_terms.OPERATION_NAMES.csv_url_load;
        bulk_load_stub = sandbox.stub().returns(BULK_LOAD_RESPONSE);
        csv_rewire.__set__('p_bulk_load', bulk_load_stub);
    });
    afterEach(function () {
        sandbox.restore();
    });
    after(function() {

    });

    it('Test csvFileLoad nominal case with valid file and valid column names/data', async function () {
        try {
            test_msg.file_path = VALID_CSV_PATH;
            let result = await csv_rewire.csvFileLoad(test_msg);
            assert.equal(result, BULK_LOAD_RESPONSE.message, 'Got incorrect response');
        } catch (e) {
            throw e;
        }
    });
    it('Test csvDataLoad invalid column names, expect exception', async function() {
        test_msg.file_path = INVALID_CSV_PATH;
        let response = undefined;
        await csv_rewire.csvFileLoad(test_msg).catch( (e) => {
            response = e;
        });
        assert.ok((response instanceof Error) === true, 'Did not get expected exception');
    });
    it('Test csvDataLoad bad file path, expect exception', async function() {
        test_msg.file_path = '/tmp/yaddayadda.csv';
        let response = undefined;
        await csv_rewire.csvFileLoad(test_msg).catch( (e) => {
            response = e;
        });
        assert.ok((response instanceof Error) === true, 'Did not get expected exception');
    });
    it('Test csvDataLoad file path to empty file, expect exception', async function() {
        test_msg.file_path = EMPTY_FILE_PATH;
        let response = undefined;
        let result = await csv_rewire.csvFileLoad(test_msg).catch( (e) => {
            response = e;
        });
        assert.equal(result, 'No records parsed from csv file.', 'Got incorrect response');
    });
});