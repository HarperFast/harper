"use strict";

const assert = require('assert');
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const write_file = rewire('../../../utility/fs/writeFile');
const writeFile = write_file.__get__('writeFile');
const writeLink = write_file.__get__('writeLink');

const BASE_TEST_PATH = path.join(__dirname, '../../../test/writeFileTest/');
const EXISTING_FOLDER_PATH = path.join(BASE_TEST_PATH, 'existingFolder');
const EXISTING_FOLDER_FILE_PATH = path.join(EXISTING_FOLDER_PATH, 'tmp.txt');
const EXISTING_FOLDER_NEW_FILE_PATH = path.join(EXISTING_FOLDER_PATH, 'new.txt');
const EXISTING_FOLDER_NEW_LINK_PATH = path.join(EXISTING_FOLDER_PATH, 'new_link.txt');
const MISSING_FOLDER_PATH = path.join(BASE_TEST_PATH, 'missingFolder');
const MISSING_FOLDER_FILE_PATH = path.join(MISSING_FOLDER_PATH, 'tmp.txt');
const MISSING_FOLDER_LINK_PATH = path.join(MISSING_FOLDER_PATH, 'tmp_link.txt');
const FILE_DATA = 'testing hdb!';

const MISSING_FOLDER_FILE_OBJECT = {
    path: MISSING_FOLDER_FILE_PATH,
    value: FILE_DATA
};

const MISSING_FOLDER_LINK_OBJECT = {
    path: EXISTING_FOLDER_FILE_PATH,
    link_path: MISSING_FOLDER_LINK_PATH
};

const EXISTING_FOLDER_FILE_OBJECT = {
    path: EXISTING_FOLDER_NEW_FILE_PATH,
    value: FILE_DATA,
    link_path: EXISTING_FOLDER_NEW_LINK_PATH
};

const EXISTING_FOLDER_LINK_OBJECT = {
    path: EXISTING_FOLDER_FILE_PATH,
    link_path: EXISTING_FOLDER_NEW_LINK_PATH
};


describe('Test writeFile module', ()=>{
   beforeEach(async ()=>{
       await fs.emptyDir(BASE_TEST_PATH);
       await fs.mkdirp(EXISTING_FOLDER_PATH);
       await fs.writeFile(EXISTING_FOLDER_FILE_PATH, FILE_DATA);
   });

    after(async ()=>{
        await fs.emptyDir(BASE_TEST_PATH);
        await fs.rmdir(BASE_TEST_PATH);
    });

    it('test createMissingFolder', ()=>{
        let createMissingFolder = write_file.__get__('createMissingFolder');

        assert.doesNotReject(async ()=>{
            await createMissingFolder(MISSING_FOLDER_FILE_PATH);
        });

        assert.doesNotReject(async ()=>{
            await fs.access(MISSING_FOLDER_PATH);
        });
    });

    it('test writeFile, folder doesn\'t exist', async ()=>{
        //verify folder doesn't exist
        assert.rejects(async ()=>{
            await fs.access(MISSING_FOLDER_PATH);
        }, );

        await writeFile(MISSING_FOLDER_FILE_OBJECT);

        assert.doesNotReject(async ()=>{
            await fs.access(MISSING_FOLDER_PATH);
        });

        assert.doesNotReject(async ()=>{
            await fs.access(MISSING_FOLDER_FILE_PATH);
        });
    });

    it('test writeFile, folder does exist', async ()=>{
        //verify folder doesn't exist
        assert.doesNotReject(async ()=>{
            await fs.access(EXISTING_FOLDER_FILE_PATH);
        }, );

        await writeFile(EXISTING_FOLDER_FILE_OBJECT);

        assert.doesNotReject(async ()=>{
            await fs.access(EXISTING_FOLDER_NEW_FILE_PATH);
        });
    });

    it('test writeLink, folder doesn\'t exist', async ()=>{
        //verify folder doesn't exist
        assert.rejects(async ()=>{
            await fs.access(MISSING_FOLDER_PATH);
        }, );

        await writeLink(MISSING_FOLDER_LINK_OBJECT);

        assert.doesNotReject(async ()=>{
            await fs.access(MISSING_FOLDER_PATH);
        });

        assert.doesNotReject(async ()=>{
            await fs.access(MISSING_FOLDER_LINK_PATH);
        });
    });

    it('test writeLink, folder does exist', async ()=>{
        //verify folder doesn't exist
        assert.doesNotReject(async ()=>{
            await fs.access(EXISTING_FOLDER_FILE_PATH);
        }, );

        await writeLink(EXISTING_FOLDER_LINK_OBJECT);

        assert.doesNotReject(async ()=>{
            await fs.access(EXISTING_FOLDER_NEW_LINK_PATH);
        });
    });
});