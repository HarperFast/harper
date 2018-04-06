"use strict";

const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.changeProcessToBinDir();

const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const delete_rewire = rewire('../../data_layer/delete');
const fs = require('graceful-fs');
const moment = require('moment');
const global_schema = require('../utility/globalSchema');
const bulk_delete_validator = require('../validation/bulkDeleteValidator');

const TEST_FILE_NAME_1 = 'test1.hdb';
const TEST_FILE_NAME_2 = 'test2.hdb';
const TEST_FILE_NAME_3 = 'test3.hdb';
const FILE_CONTENTS = "Hey there!";
const DELETE_MOD_BASE_PATH_NAME = 'hdb_path';
const TEST_ATTRIBUTE_NAME = 'TestAtt';

const BASE = process.cwd();
const BAD_DIR_PATH = '/tmp/zaphodbettlebrox';
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

const TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, TEST_FILE_NAME_3);
const TABLE_1_ATTRIBUTE_2_INSTANCE_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_3);

const TEST_TABLE_3 = 'test_dir3';
const TEST_TABLE_3_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_3);

const TOMORROW_TIME = moment().add(1, 'days');
const YESTERDAY_TIME = moment().subtract(1, 'days');

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
    fs.writeFileSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH);
    fs.linkSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH, TABLE_1_ATTRIBUTE_2_INSTANCE_FILE_PATH);

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

describe('Test deleteFilesBefore', function () {

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
        delete_rewire.deleteFilesBefore(YESTERDAY_TIME, TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(msg, `Deleted 0 files`);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            done();
        });
    });
    it('Nominal path of deleteFilesBefore', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore(TOMORROW_TIME, TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(msg, `Deleted 2 files`);
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

    it(`Call deleteFileBefore with null schema`, function(done) {
        delete_rewire.deleteFilesBefore(TOMORROW_TIME, null, TEST_TABLE_1, function del(err, msg) {
            assert.equal(err, "Invalid schema.");
            done();
        });
    });

    it(`Call deleteFileBefore with null table`, function(done) {
        delete_rewire.deleteFilesBefore(TOMORROW_TIME, TEST_SCHEMA, null, function del(err, msg) {
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
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore('1969-01-01', TEST_SCHEMA, TEST_TABLE_1, function del(err, msg) {
            assert.equal(err, null);
            done();
        });
    });
});

describe('Test doesDirectoryExist', function () {
    let doesDirectoryExist = delete_rewire.__get__('doesDirectoryExist');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
    before( function() {
        try {
            setup();
        } catch(e) {
            console.error(e);
        }
    });
    after( function() {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path with directory that exists.', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        doesDirectoryExist(TEST_TABLE_1_PATH, function doneChecking(err) {
            assert.equal(err, null);
            done();
        });
    });
    it('Test non existent directory', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        doesDirectoryExist('/tmp/howdyho', function doneChecking(err) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('Test null directory', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        doesDirectoryExist(null, function doneChecking(err) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
});

describe('Test getFiles', function () {
    let getFiles = delete_rewire.__get__('getFiles');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
    before( function() {
        try {
            setup();
        } catch(e) {
            console.error(e);
        }
    });
    after( function() {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path testing getFiles with valid directories.', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFiles([TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH], function doneChecking(err, found_files) {
            let keys = Object.keys(found_files);
            assert.equal(keys.length, 1);
            let values = found_files[keys[0]];
            // There should be 2 files in the path
            assert.equal(found_files[keys[0]].files.length, 2);
            done();
        });
    });
    it('Nominal path testing getFiles with 2 valid directories.', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFiles([TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH], function doneChecking(err, found_files) {
            let keys = Object.keys(found_files);
            assert.equal(keys.length, 2);
            // There should be 2 files in table 1 hash path
            assert.equal(found_files[keys[0]].files.length, 2);
            // There should be 2 files in table 1 attribute path
            assert.equal(found_files[keys[1]].files.length, 2);
            done();
        });
    });
    it('Nominal path testing getFiles with 2 valid directories and 1 invalid.', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFiles([TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH,  BAD_DIR_PATH], function doneChecking(err, found_files) {
            let keys = Object.keys(found_files);
            // Should not have an entry for the bad directory path.
            assert.equal(keys.length, 2);
            // There should be 2 files in table 1 hash path
            assert.equal(found_files[keys[0]].files.length, 2);
            // There should be 2 files in table 1 attribute path
            assert.equal(found_files[keys[1]].files.length, 2);
            done();
        });
    });
    it('Pass in empty array, expect empty object back.', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFiles([], function doneChecking(err, found_files) {
            let keys = Object.keys(found_files);
            assert.equal(keys.length, 0);
            done();
        });
    });
    it('Pass in array with invalid path', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFiles([BAD_DIR_PATH], function doneChecking(err, found_files) {
            let keys = Object.keys(found_files);
            assert.equal(keys.length, 0);
            done();
        });
    });
});

describe('Test removeFiles', function() {
    let removeFiles = delete_rewire.__get__('removeFiles');
    let files_to_remove = [TEST_FILE_NAME_1, TEST_FILE_NAME_3];
    beforeEach( function(done) {
        try {
            setup();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    afterEach( function(done) {
        try {
            tearDown(TEST_SCHEMA_PATH);
            done();
        } catch(e) {
            console.log(e);
        }
    });
    it('Nominal path of removeFiles', function (done) {
        removeFiles(TOMORROW_TIME, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, files_to_remove, function(err, results) {
            assert.equal(results, 2);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), false);
            done();
        });
    });
    it('removeFiles with files parameter having 1 bad filename', function (done) {
        let local_files = [TEST_FILE_NAME_1, TEST_FILE_NAME_2];
        removeFiles(TOMORROW_TIME, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, local_files, function(err, results) {
            assert.equal(results, 1);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('removeFiles with empty files parameter', function (done) {
        let local_files = [];
        removeFiles(TOMORROW_TIME, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, local_files, function(err, results) {
            assert.equal(results, 0);
            done();
        });
    });
    it('removeFiles with 2 invalid files parameter', function (done) {
        let local_files = ['bad', 'silly'];
        removeFiles(TOMORROW_TIME, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, local_files, function(err, results) {
            assert.equal(results, 0);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('removeFiles with null files parameter', function (done) {
        let local_files = null;
        removeFiles(TOMORROW_TIME, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, local_files, function(err, results) {
            assert.equal(results, 0);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('removeFiles with null path parameter', function (done) {
        removeFiles(TOMORROW_TIME, null, files_to_remove, function(err, results) {
            assert.equal(results, 0);
            assert.ok(err instanceof Error);
            assert.ok(err.message.length > 0);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('removeFiles with null date parameter', function (done) {
        removeFiles(null, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, files_to_remove, function(err, results) {
            assert.equal(results, 0);
            assert.ok(err instanceof Error);
            assert.ok(err.message.length > 0);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('removeFiles with yesterday as a date', function (done) {
        removeFiles(YESTERDAY_TIME, TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, files_to_remove, function(err, results) {
            assert.equal(results, 0);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
});

describe('Test getFilesInDirectory', function () {
    let getFilesInDirectory = delete_rewire.__get__('getFilesInDirectory');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
    before( function() {
        try {
            setup();
        } catch(e) {
            console.error(e);
        }
    });
    after( function() {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path testing getFilesInDirectory.', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFilesInDirectory(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, function doneChecking(err, found_files) {
            assert.equal(found_files.length, 2);
            done();
        });
    });
    it('getFilesInDirectory with null dir path', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFilesInDirectory(null, function doneChecking(err, found_files) {
            assert.ok(err instanceof Error);
            assert.ok(err.message.length > 0);
            assert.ok(found_files !== null);
            done();
        });
    });
    it('getFilesInDirectory with invalid dir path', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFilesInDirectory(BAD_DIR_PATH, function doneChecking(err, found_files) {
            assert.ok(err instanceof Error);
            assert.ok(err.message.length > 0);
            assert.ok(found_files !== null);
            done();
        });
    });
    it('getFilesInDirectory with empty dir path', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        getFilesInDirectory(TEST_TABLE_3_PATH, function doneChecking(err, found_files) {
            assert.equal(found_files.length, 0);
            done();
        });
    });
});

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

describe('Test deleteRecord', function () {
    beforeEach( function(done) {
        try {
            setup();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    afterEach( function(done) {
        try {
            tearDown(TEST_SCHEMA_PATH);
            done();
        } catch(e) {
            console.log(e);
        }
    });
    it('test listDirectories with no directories found', function (done) {
        listDirectories(TEST_TABLE_3_PATH, function(err, results) {
            done();
        });
    });
});



