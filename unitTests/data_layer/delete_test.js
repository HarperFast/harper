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
const TABLE_1_ATTRIBUTE_HASH_PATH = path.join(TEST_TABLE_1_HASH, TEST_ATTRIBUTE_NAME);
const TABLE_1_ATTRIBUTE_INSTANCE_PATH = path.join(TABLE_1_ATTRIBUTE_PATH, FILE_CONTENTS);

const TEST_TABLE_2 = 'test_dir2';
const TEST_TABLE_2_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_2);
const TEST_TABLE_2_HASH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_2, HDB_HASH_FOLDER_NAME);
const TABLE_2_ATTRIBUTE_PATH = path.join(TEST_TABLE_2_PATH, TEST_ATTRIBUTE_NAME);
const TABLE_2_ATTRIBUTE_HASH_PATH = path.join(TEST_TABLE_2_HASH, TEST_ATTRIBUTE_NAME);
const TABLE_2_ATTRIBUTE_INSTANCE_PATH = path.join(TABLE_2_ATTRIBUTE_PATH, FILE_CONTENTS);

const TEST_TABLE_3 = 'test_dir3';
const TEST_TABLE_3_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_3);

function setup() {
    // Setup table 1
    fs.mkdirSync(TEST_SCHEMA_PATH);
    fs.mkdirSync(TEST_TABLE_1_PATH);
    fs.mkdirSync(TEST_TABLE_1_HASH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_HASH_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_INSTANCE_PATH);
    let hash_attribute_path = path.join(TABLE_1_ATTRIBUTE_HASH_PATH, TEST_FILE_NAME_1);
    let attribute_path = path.join(TABLE_1_ATTRIBUTE_INSTANCE_PATH, TEST_FILE_NAME_1);
    fs.writeFileSync(hash_attribute_path, `${FILE_CONTENTS}.hdb`);
    fs.linkSync(hash_attribute_path, attribute_path);

    // Setup table 2
    fs.mkdirSync(TEST_TABLE_2_PATH);
    fs.mkdirSync(TEST_TABLE_2_HASH);
    fs.mkdirSync(TABLE_2_ATTRIBUTE_PATH);
    fs.mkdirSync(TABLE_2_ATTRIBUTE_HASH_PATH);
    fs.mkdirSync(TABLE_2_ATTRIBUTE_INSTANCE_PATH);
    hash_attribute_path = path.join(TABLE_2_ATTRIBUTE_HASH_PATH, TEST_FILE_NAME_2);
    attribute_path = path.join(TABLE_2_ATTRIBUTE_INSTANCE_PATH, TEST_FILE_NAME_2);
    fs.writeFileSync(hash_attribute_path, `${FILE_CONTENTS}.hdb`);
    fs.linkSync(hash_attribute_path, attribute_path);

    //Setup empty table 3
    fs.mkdirSync(TEST_TABLE_3_PATH);
    // Writes a text file to ensure listDirectories only shows directories
    fs.writeFileSync(path.join(TEST_SCHEMA_PATH, TEST_FILE_NAME_2), FILE_CONTENTS);
}

function shutdown() {
    // Remove table 1
    /*fs.unlinkSync(path.join(TEST_TABLE_1_HASH, TEST_FILE_NAME_1));
    fs.unlinkSync(path.join(TEST_TABLE_1_PATH, TEST_FILE_NAME_1));
    fs.rmdirSync(TEST_TABLE_1_HASH);
    fs.rmdirSync(TEST_TABLE_1_PATH);

    //Remove table 2
    fs.unlinkSync(path.join(TEST_TABLE_2_HASH, TEST_FILE_NAME_2));
    fs.unlinkSync(path.join(TEST_TABLE_2_PATH, TEST_FILE_NAME_2));
    fs.rmdirSync(TEST_TABLE_2_HASH);
    fs.rmdirSync(TEST_TABLE_2_PATH);

    // Remove extra test file
    fs.unlinkSync(path.join(BASE, TEST_FILE_NAME_2));

    //Remove empty table
    fs.rmdirSync(TEST_TABLE_3_PATH);

    // Remove schema
    fs.rmdirSync(TEST_SCHEMA_PATH); */
}

describe('Test listDirectories', function () {
    let listDirectories = delete_rewire.__get__('listDirectories');
    before( function() {
        try {
            setup();
        } catch(e) {
            console.error(e);
        }
    });
    after( function() {
        try {
            shutdown();
        } catch(e) {
            console.error(e);
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
    let this_time = moment().add(1, 'days');
    before( function() {
        try {
            setup();
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path of deleteFilesBefore', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteFilesBefore(this_time, TEST_SCHEMA, TEST_TABLE_1, function del(err) {
            done();
        });
    });
});