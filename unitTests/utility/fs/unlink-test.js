"use strict";

const unlink = require('../../../utility/fs/unlink');
const rewire = require('rewire');
const unlink_rw = rewire('../../../utility/fs/unlink');
const fs = require('fs-extra');
const assert = require('assert');
const path = require('path');
const test_utils = require('../../test_utils');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'unlinkTest');
const FOLDER_1_FILE_PATH = path.join(BASE_TEST_PATH, 'folder_1_file/');
const FILE_IN_FOLDER_1_FILE_PATH = path.join(FOLDER_1_FILE_PATH, 'tmp1.txt');
const FOLDER_2_FILES_PATH = path.join(BASE_TEST_PATH, 'folder_2_files/');
const FILE_1_IN_FOLDER_2_FILES_PATH = path.join(FOLDER_2_FILES_PATH, 'tmp1.txt');
const FILE_2_IN_FOLDER_2_FILES_PATH = path.join(FOLDER_2_FILES_PATH, 'tmp2.txt');
const FILE_TEXT = 'hello tests!';

describe('Test unlink module', ()=>{
    before(async ()=>{
        //create folder to hold the tests
        await fs.mkdirp(BASE_TEST_PATH);
        await fs.mkdirp(FOLDER_1_FILE_PATH);
        await fs.writeFile(FILE_IN_FOLDER_1_FILE_PATH, FILE_TEXT);
        await fs.mkdirp(FOLDER_2_FILES_PATH);
        await fs.writeFile(FILE_1_IN_FOLDER_2_FILES_PATH, FILE_TEXT);
        await fs.writeFile(FILE_2_IN_FOLDER_2_FILES_PATH, FILE_TEXT);
    });

    after(async ()=>{
        await fs.emptyDir(BASE_TEST_PATH);
        await fs.rmdir(BASE_TEST_PATH);
        test_utils.tearDownMockFS();
    });

    it('test deleting lone file in folder, verify file & parent dir is deleted', async ()=>{
        await unlink.unlink([FILE_IN_FOLDER_1_FILE_PATH]);
        //check file is gone
        assert.rejects(async ()=>{
            await fs.access(FILE_IN_FOLDER_1_FILE_PATH);
        }, {code:'ENOENT'});

        //check parent dir is gone
        assert.rejects(async ()=>{
            await fs.access(FOLDER_1_FILE_PATH);
        }, {code:'ENOENT'});
    });

    it('test deleting 1 file in folder with another file, verify file is deleted, but parent dir & other file exist', async ()=>{
        await unlink.unlink([FILE_1_IN_FOLDER_2_FILES_PATH]);
        //check file is gone
        assert.rejects(async ()=>{
            await fs.access(FILE_1_IN_FOLDER_2_FILES_PATH);
        }, {code:'ENOENT'});

        assert.doesNotReject(async ()=>{
            await fs.access(FOLDER_2_FILES_PATH);
        });

        assert.doesNotReject(async ()=>{
            await fs.access(FILE_2_IN_FOLDER_2_FILES_PATH);
        });
    });
});

describe('Test unlink_delete_object module', ()=>{
    before(async ()=>{
        //create folder to hold the tests
        await fs.mkdirp(BASE_TEST_PATH);
        await fs.mkdirp(FOLDER_1_FILE_PATH);
        await fs.writeFile(FILE_IN_FOLDER_1_FILE_PATH, FILE_TEXT);
        await fs.mkdirp(FOLDER_2_FILES_PATH);
        await fs.writeFile(FILE_1_IN_FOLDER_2_FILES_PATH, FILE_TEXT);
        await fs.writeFile(FILE_2_IN_FOLDER_2_FILES_PATH, FILE_TEXT);
    });

    after(async ()=>{
        await fs.emptyDir(BASE_TEST_PATH);
        await fs.rmdir(BASE_TEST_PATH);
        test_utils.tearDownMockFS();
    });

    it('test deleting lone file in folder, verify file & parent dir is deleted', async ()=>{
        let input_object = Object.create(null);
        input_object[1] = [FILE_IN_FOLDER_1_FILE_PATH];
        await unlink.unlink_delete_object(input_object);
        //check file is gone
        assert.rejects(async ()=>{
            await fs.access(FILE_IN_FOLDER_1_FILE_PATH);
        }, {code:'ENOENT'});

        //check parent dir is gone
        assert.rejects(async ()=>{
            await fs.access(FOLDER_1_FILE_PATH);
        }, {code:'ENOENT'});
    });

    it('test deleting 1 file in folder with another file, verify file is deleted, but parent dir & other file exist', async ()=>{
        let input_object = Object.create(null);
        input_object[1] = [FILE_1_IN_FOLDER_2_FILES_PATH];
        await unlink.unlink_delete_object(input_object);
        //check file is gone
        assert.rejects(async ()=>{
            await fs.access(FILE_1_IN_FOLDER_2_FILES_PATH);
        }, {code:'ENOENT'});

        assert.doesNotReject(async ()=>{
            await fs.access(FOLDER_2_FILES_PATH);
        });

        assert.doesNotReject(async ()=>{
            await fs.access(FILE_2_IN_FOLDER_2_FILES_PATH);
        });
    });

    it('test deleting multiple files, ensure message tracks the id of the failure', async () => {
        let input_object = Object.create(null);
        input_object[1] = [FILE_IN_FOLDER_1_FILE_PATH];
        input_object[2] = [FILE_2_IN_FOLDER_2_FILES_PATH];

        let result = await unlink_rw.unlink_delete_object(input_object);
        assert.strictEqual(result.skipped_hashes.length, 0, 'expected a skipped file to be reported');
        assert.strictEqual(result.deleted_hashes.length, 2, 'expected a skipped file to be reported');
    });

    it('test deleting with all file delete failure, ensure message tracks the id of the failure', async () => {
        let input_object = Object.create(null);
        input_object[1] = [FILE_IN_FOLDER_1_FILE_PATH];
        input_object[2] = [FILE_2_IN_FOLDER_2_FILES_PATH];
        //Simulate a delete failure
        function unlink_stub(path) {
          throw new Error('File Delete Failure!!');
        }
        let fs_unlink_orig = unlink_rw.__get__('fs_unlink');
        unlink_rw.__set__('fs_unlink', unlink_stub);
        let result = await unlink_rw.unlink_delete_object(input_object);
        assert.strictEqual(result.skipped_hashes.length, 2, 'expected a skipped file to be reported');
        assert.strictEqual(result.deleted_hashes.length, 0, 'expected no deleted hashes');
        // restore
        unlink_rw.__set__('fs_unlink',fs_unlink_orig);
    });
    it('test unlink with invalid input', async () => {
        let result = await unlink_rw.unlink_delete_object(null);
        assert.strictEqual(result.skipped_hashes.length, 0, 'expected no skipped hashes');
        assert.strictEqual(result.deleted_hashes.length, 0, 'expected no deleted hashes');
    });
});