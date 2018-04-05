"use strict";

const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const delete_rewire = rewire('../../data_layer/delete');
const fs = require('graceful-fs');
const moment = require('moment');
const path = require('path');

const TEST_FILE_NAME_1 = 'test1.hdb';
const TEST_FILE_NAME_2 = 'test2.hdb';
const FILE_CONTENTS = "Hey there!";
const DELETE_MOD_BASE_PATH_NAME = 'hdb_path';
const TEST_ATTRIBUTE_NAME = 'TestAtt';

const BASE = process.cwd();
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const TEST_SCHEMA = 'test';
const TEST_SCHEMA_PATH = path.join(BASE, TEST_SCHEMA);
const TEST_TABLE_1 = 'test_dir1';
const TEST_TABLE_1_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_1);
const TEST_TABLE_1_HASH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_1, HDB_HASH_FOLDER_NAME);

const TABLE_1_ATTRIBUTE_PATH = path.join(TEST_TABLE_1_PATH, TEST_ATTRIBUTE_NAME);
const TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH = path.join(TEST_TABLE_1_HASH, TEST_ATTRIBUTE_NAME);
const TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH = path.join(TABLE_1_ATTRIBUTE_PATH, FILE_CONTENTS);
const TABLE_1_ATTRIBUTE_HASH_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, TEST_FILE_NAME_1);
const TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_1);

const TEST_TABLE_2 = 'test_dir2';
const TEST_TABLE_2_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_2);
const TEST_TABLE_2_HASH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_2, HDB_HASH_FOLDER_NAME);
const TABLE_2_ATTRIBUTE_PATH = path.join(TEST_TABLE_2_PATH, TEST_ATTRIBUTE_NAME);
const TABLE_2_ATTRIBUTE_HASH_DIRECTORY_PATH = path.join(TEST_TABLE_2_HASH, TEST_ATTRIBUTE_NAME);
const TABLE_2_ATTRIBUTE_INSTANCE_DIRECTORY_PATH = path.join(TABLE_2_ATTRIBUTE_PATH, FILE_CONTENTS);
const TABLE_2_ATTRIBUTE_HASH_FILE_PATH = path.join(TABLE_2_ATTRIBUTE_HASH_DIRECTORY_PATH, TEST_FILE_NAME_2);
const TABLE_2_ATTRIBUTE_INSTANCE_FILE_PATH = path.join(TABLE_2_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_2);

const TEST_TABLE_3 = 'test_dir3';
const TEST_TABLE_3_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_3);

function setup() {
    // Setup table 1
    fs.mkdirSync(TEST_SCHEMA_PATH);
    fs.mkdirSync(TEST_TABLE_1_PATH);
    fs.mkdirSync(TEST_TABLE_1_HASH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH);
    fs.writeFileSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH);
    fs.linkSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH, TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH);

    // Setup table 2
    fs.mkdirSync(TEST_TABLE_2_PATH);
    fs.mkdirSync(TEST_TABLE_2_HASH);
    fs.mkdirSync(TABLE_2_ATTRIBUTE_PATH);
    fs.mkdirSync(TABLE_2_ATTRIBUTE_HASH_DIRECTORY_PATH);
    fs.mkdirSync(TABLE_2_ATTRIBUTE_INSTANCE_DIRECTORY_PATH);
    fs.writeFileSync(TABLE_2_ATTRIBUTE_HASH_FILE_PATH);
    fs.linkSync(TABLE_2_ATTRIBUTE_HASH_FILE_PATH, TABLE_2_ATTRIBUTE_INSTANCE_FILE_PATH);

    //Setup empty table 3
    fs.mkdirSync(TEST_TABLE_3_PATH);
    // Writes a text file to ensure listDirectories only shows directories
    fs.writeFileSync(path.join(TEST_SCHEMA_PATH, TEST_FILE_NAME_2), FILE_CONTENTS);
}

function tearDown(target_path) {
    if(!target_path) return;
    let files = [];
    if( fs.existsSync(target_path) ) {
        files = fs.readdirSync(target_path);
        files.forEach(function(file,index){
            let curPath = path.join(target_path, file);
            if(fs.lstatSync(curPath).isDirectory()) { // recurse
                tearDown(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(target_path);
    }
};

describe('Test listDirectories', function () {
    let listDirectories = delete_rewire.__get__('listDirectories');
    before( function() {
        try {
            setup();
        } catch(e) {
            //console.error(e);
        }
    });
    after( function() {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch(e) {
            //console.error(e);
        }
    });
    // There should be 2 directories, each with 1 file, and 1 text file in the current directory
    it('Nominal path of listDirectories', function (done) {
        listDirectories(TEST_SCHEMA_PATH, function(err, results) {
            assert.equal(results.length, 3);
            done();
        });
    });

    it('test listDirectories with a null path', function (done) {
        listDirectories(null, function(err, results) {
            assert.ok(err.message.length > 0);
            assert.equal(results.length, 0);
            done();
        });
    });

    it('test listDirectories with a space as path', function (done) {
        listDirectories(' ', function(err, results) {
            assert.ok(err.message.length > 0);
            assert.equal(results.length, 0);
            done();
        });
    });

    it('test listDirectories with an invalid path', function (done) {
        listDirectories('../askdsdfsadc', function(err, results) {
            assert.equal(err.errno, '-2');
            assert.equal(results.length, 0);
            done();
        });
    });

    it('test listDirectories with no directories found', function (done) {
        listDirectories(TEST_TABLE_3_PATH, function(err, results) {
            assert.equal(results.length, 0);
            done();
        });
    });
});

describe('Test deleteFilesBefore', function () {
    let tomorrow_time = moment().add(1, 'days');
    let yesterday_time = moment().subtract(1, 'days');
    before(function () {
        try {
            setup();
            delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        } catch (e) {
            console.error(e);
        }
    });
    after(function () {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch (e) {
            console.error(e);
        }
    });
    it('deleteFilesBefore with yesterday as a time stamp', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore(yesterday_time, TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(msg, `Deleted 0 files`);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            done();
        });
    });
    it('Nominal path of deleteFilesBefore', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore(tomorrow_time, TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(msg, `Deleted 1 files`);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
            done();
        });
    });
    it('Call deleteFilesBefore in directory with no files', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore(tomorrow_time, TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(msg, `Deleted 0 files`);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
            done();
        });
    });
    it('Call deleteFilesBefore with null date', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore(null, TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(err, 'Invalid date.');
            done();
        });
    });

    it(`Call deleteFileBefore with invalid schema`, function(done) {
        delete_rewire.deleteFilesBefore(tomorrow_time, null, TEST_TABLE_1, function del(err, msg) {
            assert.equal(err, "Invalid schema.");
            done();
        });
    });

    it(`Call deleteFileBefore with invalid table`, function(done) {
        delete_rewire.deleteFilesBefore(tomorrow_time, TEST_SCHEMA, null, function del(err, msg) {
            assert.equal(err, "Invalid table.");
            done();
        });
    });

    it('Call deleteFilesBefore with valid date strings', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        // Test nominal case
        delete_rewire.deleteFilesBefore('2011-01-11', TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(err, null);
            done();
        });
    });
        // Test date with Times included
     it('Call with valid date/time', function(done) {
         delete_rewire.deleteFilesBefore('2011-01-11T17:45:55+00:00', TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
             assert.equal(err, null);
             done();
         });
     });
        // Test leap year silliness
     it('Call with invalid leap year', function(done) {
         delete_rewire.deleteFilesBefore('2011-02-29', TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
             assert.equal(err, 'Invalid date.');
             done();
         });
     });
        //Test Epoc
     it('Call with Epoc', function(done) {
         delete_rewire.deleteFilesBefore('1969-01-01', TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
             assert.equal(err, null);
             done();
         });
     });
});