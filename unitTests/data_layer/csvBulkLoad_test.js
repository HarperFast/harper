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

const VALID_CSV_DATA = "id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const INVALID_CSV_ID_COLUMN_NAME = "id/,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const INVALID_CSV_SECTION_COLUMN_NAME = "id,name,sect ion,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n";
const VALID_CSV_PATH = '/tmp/csv_input_valid.csv';
const INVALID_CSV_PATH = '/tmp/csv_input_invalid_id.csv';
const HOSTED_CSV_FILE_URL = 'https://s3.amazonaws.com/complimentarydata/breeds.csv';

const BULK_LOAD_RESPONSE = {
    message: 'successfully loaded 3 of 3 records'
};

const BULK_LOAD_ORIG = csv_rewire.__get__('p_bulk_load');
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
});