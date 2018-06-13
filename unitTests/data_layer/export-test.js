'use strict';

const test_util = require('../test_utils');
test_util.preTestPrep();

const assert = require('assert');
const rewire = require('rewire');
const hdb_export = rewire('../../data_layer/export');
const sinon = require('sinon');
const fs = require('fs');
const {promisify} = require('util');

// Promisified functions
const p_fs_stat = promisify(fs.stat);

const TEST_OBJECT = { "text": "blah blah"};
const SEARCH_RESPONSE = [TEST_OBJECT];

describe('Test confirmPath', function() {
    let confirmPath = hdb_export.__get__('confirmPath');

    let sandbox = null;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('Nominal case of confirmPath', test_util.mochaAsyncWrapper(async function() {
        let test_path = './';
        let is_path_valid = await confirmPath(test_path);
        assert.equal(is_path_valid, true, "Expected valid path");
    }));
    it('call confirmPath with bad path', async function() {
        let test_path = './zaphodbeeblebrox';
        let is_path_valid = await confirmPath(test_path).catch( (err) => {
            assert.ok(err.message.length > 0, "Expected Error message");
            assert.ok(err.message.indexOf('does not exist') >= 0, "Expected Error message");
        });
        assert.equal(is_path_valid, undefined, "Expected undefined retult");
    });
    it('call confirmPath with non directory path', async function() {
        let test_path = './harperdb.js';
        let is_path_valid = await confirmPath(test_path).catch( (err) => {
            assert.ok(err.message.length > 0, "Expected Error message");
            assert.ok(err.message.indexOf('is not a directory') >= 0, "Expected Error message");
        });
        assert.equal(is_path_valid, undefined, "Expected undefined retult");
    });
    it('call confirmPath with undefined path', async function() {
        let test_path = undefined;
        let is_path_valid = await confirmPath(test_path).catch( (err) => {
            assert.ok(err.message.length > 0, "Expected Error message");
            assert.ok(err.message.indexOf('Invalid path') >= 0, "Expected Error message");
        });
        assert.equal(is_path_valid, undefined, "Expected undefined retult");
    });
});

//file_path, format, data) {
describe('Test saveToLocal', function() {
    let saveToLocal = hdb_export.__get__('saveToLocal');
    let test_path = './';
    let file_name = undefined;
    let data_object = { "text": "blah blah"};
    let csv_data = 'text, blah blah';
    let sandbox = null;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
        try {
            fs.unlinkSync(file_name);
        } catch(e) {
            //no-op, this is ok.
        }
    });

    it('Nominal case of saveToLocal with json', test_util.mochaAsyncWrapper(async function() {
        file_name = test_path + 'test_file.json';
        let wrote_data = await saveToLocal(file_name, 'json', data_object);
        assert.equal(wrote_data, true, "Expected valid path");
        let stats = p_fs_stat(file_name).catch( (e) => {
           throw e;
        });
        assert.ok(stats, true, "Expected file to be found");
        let file = fs.readFileSync(file_name, 'utf-8');
        assert.ok(file.length > 0, "File was empty");
        let converted = JSON.parse(file);
        assert.equal(converted.text, "blah blah", "Got incorrect file text value");
    }));
    it('Nominal case of saveToLocal with csv', test_util.mochaAsyncWrapper(async function() {
        file_name = test_path + 'test_file.json';
        let wrote_data = await saveToLocal(file_name, 'csv', csv_data);
        assert.equal(wrote_data, true, "Expected valid path");
        let stats = p_fs_stat(file_name).catch( (e) => {
            throw e;
        });
        assert.ok(stats, true, "Expected file to be found");
        let file = fs.readFileSync(file_name, 'utf-8');
        assert.ok(file.length > 0, "File was empty");
        assert.equal(file, csv_data, "Got incorrect file text value");
    }));
    it('Call saveToLocal with invalid path', async function() {
        file_name = test_path + 'test_file.json';
        let wrote_data = undefined;
        let err = undefined;
        try {
            wrote_data = await saveToLocal(null, 'csv', csv_data);
        } catch(e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "Expected error message");
        assert.ok(err.message.indexOf('file_path parameter') >= 0, "Incorrect error found");
    });
    it('Call saveToLocal with invalid format', async function() {
        file_name = test_path + 'test_file.json';
        let wrote_data = undefined;
        let err = undefined;
        try {
            wrote_data = await saveToLocal(file_name, null, csv_data);
        } catch(e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "Expected error message");
        assert.ok(err.message.indexOf('Invalid source format') >= 0, "Incorrect error found");
    });
    it('Call saveToLocal with invalid data', async function() {
        file_name = test_path + 'test_file.json';
        let wrote_data = undefined;
        let err = undefined;
        try {
            wrote_data = await saveToLocal(file_name, 'csv', null);
        } catch(e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "Expected error message");
        assert.ok(err.message.indexOf('Data not found') >= 0, "Incorrect error found");
    });
    it('Call saveToLocal with empty data, this is valid', async function() {
        file_name = test_path + 'test_file.json';
        let empty_object = Object.create(null);
        let expected_file_size = 2;
        let wrote_data = await saveToLocal(file_name, 'json', empty_object);
        assert.equal(wrote_data, true, "Expected valid path");
        let stats = p_fs_stat(file_name).catch( (e) => {
            throw e;
        });
        assert.ok(stats, true, "Expected file to be found");
        let file = fs.readFileSync(file_name, 'utf-8');
        // Should only have brackets in the file
        assert.ok(file.length === expected_file_size, "File should be empty");
    });
    it('Simulate exception from writing', async function() {
        file_name = test_path + 'test_file.json';
        let write_orig = hdb_export.__get__('p_fs_writefile');
        let write_stub = sandbox.stub().throws(new Error('booo error'));
        hdb_export.__set__('p_fs_writefile', write_stub);
        let err = undefined;
        let wrote_data = undefined;
        try {
            wrote_data = await saveToLocal(file_name, 'csv', data_object);
        } catch(e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "Expected error message");
        assert.ok(err.message.indexOf('booo error') >= 0, "Incorrect error found");
        hdb_export.__set__('p_fs_writefile', write_orig);
    });
});


describe('Test searchAndConvert', function() {
    let search_stub = undefined;
    let searchAndConvert = hdb_export.__get__('searchAndConvert');
    let sandbox = null;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
    });

    it('Nominal case, expect JSON data back', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = "./";
        export_object.filename = "test_export";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        let json_results = undefined;
        try {
            json_results = await searchAndConvert(export_object);
        } catch (e) {
            throw e;
        }
        assert.equal(json_results[0].text, "blah blah", "expected specific text")
    });
    it('Call searchAndConvert with bad operation', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = "./";
        export_object.filename = "test_export";
        export_object.format = "csv";
        export_object.search_operation = null;
        let err = undefined;
        try {
            await searchAndConvert(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected specific text");
    });
    it('Call searchAndConvert with search throwing an exception', async function() {
        search_stub = sandbox.stub().throws(new Error('boooooo'));
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = "./";
        export_object.filename = "test_export";
        export_object.format = "csv";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        let err = undefined;
        try {
            await searchAndConvert(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected specific text");
        assert.ok(err.message.indexOf('booooo') >= 0, "expected specific text");
    });
});

describe('Test export_local', function() {
    let search_stub = undefined;
    let export_local = hdb_export.__get__('export_local');
    let sandbox = null;
    let test_path = './';
    let file_name = undefined;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
        try {
            fs.unlinkSync(file_name);
        } catch(e) {
            //no-op, this is ok.
        }
    });

    it('Nominal Call to export_local with csv file', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.csv';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "csv";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        try {
            await export_local(export_object);
        } catch (e) {
            throw e;
        }
        let stats = p_fs_stat(file_name).catch( (e) => {
            throw e;
        });
        assert.ok(stats, true, "Expected file to be found");
        let file = fs.readFileSync(file_name, 'utf-8');
        assert.ok(file.length > 0, "File was empty");
        assert.ok(file.indexOf('blah blah') >= 0, "Got incorrect file text value");
    });
    it('Nominal Call to export_local with json file', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.json';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        try {
            await export_local(export_object);
        } catch (e) {
            throw e;
        }
        let stats = p_fs_stat(file_name).catch( (e) => {
            throw e;
        });
        assert.ok(stats, true, "Expected file to be found");
        let file = fs.readFileSync(file_name, 'utf-8');
        let converted = JSON.parse(file);
        assert.equal(converted[0].text, "blah blah", "Got incorrect file text value");
    });
    it('Call to export_local with bad path', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.json';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = null;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        let err = undefined;
        try {
            await export_local(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
    });
    it('Call to export_local with search exception thrown', async function() {
        search_stub = sandbox.stub().throws(new Error('bah'));
        file_name = test_path + 'test_file.json';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = './';
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        let err = undefined;
        try {
            await export_local(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
        assert.ok(err.message.indexOf('bah') > 0, "expected error");
    });
});

describe('Test export_to_s3', function() {
    let search_stub = undefined;
    let export_to_s3 = hdb_export.__get__('export_to_s3');
    let sandbox = null;
    let test_path = './';
    let file_name = undefined;
    beforeEach(function () {
        sandbox = sinon.createSandbox();
    });
    afterEach(function () {
        sandbox.restore();
        try {
            fs.unlinkSync(file_name);
        } catch (e) {
            //no-op, this is ok.
        }
    });

    it('Nominal Call to export_to_s3.  Cant stub s3 so just checking error handling', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.csv';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        /*
        export_object.s3 = {
            "key":"bad",
                "bucket":"bad",
                "aws_access_key_id":"bad",
                "aws_secret_access_key":"bad"
        };
         */
        export_object.s3 = null;
        let err = undefined;
        try {
            await export_to_s3(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
        assert.ok(err.message.indexOf('S3 object missing') >= 0, "expected error");
    });
    it('Nominal Call to export_to_s3.  Cant stub s3 so just checking error handling bad access key', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.csv';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        export_object.s3 = {
            "key":"bad",
            "bucket":"bad",
            "aws_access_key_id":null,
            "aws_secret_access_key":"bad"
        };

        let err = undefined;
        try {
            await export_to_s3(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
        assert.ok(err.message.indexOf('S3.aws_access_key_id missing') >= 0, "expected error");
    });
    it('Nominal Call to export_to_s3.  Cant stub s3 so just checking error handling bad secret access key', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.csv';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        export_object.s3 = {
            "key":"bad",
            "bucket":"bad",
            "aws_access_key_id":"bad",
            "aws_secret_access_key":null
        };

        let err = undefined;
        try {
            await export_to_s3(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
        assert.ok(err.message.indexOf('S3.aws_secret_access_key missing') >= 0, "expected error");
    });
    it('Nominal Call to export_to_s3.  Cant stub s3 so just checking error handling bad bucket', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.csv';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        export_object.s3 = {
            "key":"bad",
            "bucket":null,
            "aws_access_key_id":"bad",
            "aws_secret_access_key":"bad"
        };

        let err = undefined;
        try {
            await export_to_s3(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
        assert.ok(err.message.indexOf('S3.bucket missing') >= 0, "expected error");
    });
    it('Nominal Call to export_to_s3.  Cant stub s3 so just checking error handling bad key', async function() {
        search_stub = sandbox.stub().returns(SEARCH_RESPONSE);
        file_name = test_path + 'test_file.csv';
        hdb_export.__set__('p_sql', search_stub);
        let export_object = {};
        export_object.operation = 'export_local';
        export_object.path = `${test_path}`;
        export_object.filename = "test_file";
        export_object.format = "json";
        export_object.search_operation = {
            "operation": "sql",
            "sql": "SELECT * FROM dev.breed"
        };
        export_object.s3 = {
            "key":null,
            "bucket":"bad",
            "aws_access_key_id":"bad",
            "aws_secret_access_key":"bad"
        };

        let err = undefined;
        try {
            await export_to_s3(export_object);
        } catch (e) {
            err = e;
        }
        assert.ok(err.message.length > 0, "expected error");
        assert.ok(err.message.indexOf('S3.key missing') >= 0, "expected error");
    });
});