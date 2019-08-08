"use strict";

const assert = require('assert');
const path = require('path');
const fs = require('fs-extra');
const rewire = require('rewire');
const test_utils = require('../../test_utils');
const write_file = rewire('../../../utility/fs/writeFile');
const writeFile = write_file.__get__('writeFile');
const writeLink = write_file.__get__('writeLink');
const write_files_func = write_file.__get__('writeFiles');
const write_file_work = write_file.__get__('work');
const create_missing_folder = write_file.__get__('createMissingFolder');

const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), 'writeFileTest');
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

let TEST_FILE = [
    EXISTING_FOLDER_PATH
];

let TEST_FILES = [
    EXISTING_FOLDER_PATH,
    EXISTING_FOLDER_PATH
];


describe('Test writeFile module', ()=>{
   beforeEach(async ()=>{
       await fs.emptyDir(BASE_TEST_PATH);
       await fs.mkdirp(EXISTING_FOLDER_PATH);
       await fs.writeFile(EXISTING_FOLDER_FILE_PATH, FILE_DATA);
   });

    after(async ()=>{
        await fs.emptyDir(BASE_TEST_PATH);
        await fs.rmdir(BASE_TEST_PATH);
        test_utils.tearDownMockFS();
    });

    it('test createMissingFolder', ()=>{
        assert.doesNotReject(async ()=>{
            await create_missing_folder(MISSING_FOLDER_FILE_PATH);
        });

        assert.doesNotReject(async ()=>{
            await fs.access(MISSING_FOLDER_PATH);
        });
    });

    it('test createMissingFolder simulate fs.mkdirp exception', ()=>{
        let revert = write_file.__set__('fs', {
            mkdirp:async()=>{
                throw new Error('fail!');
            }
        });

        assert.rejects(async ()=>{
            await create_missing_folder(MISSING_FOLDER_FILE_PATH);
        });

        revert();
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
        //verify folder does exist
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
        //verify folder does exist
        assert.doesNotReject(async ()=>{
            await fs.access(EXISTING_FOLDER_FILE_PATH);
        }, );

        await writeLink(EXISTING_FOLDER_LINK_OBJECT);

        assert.doesNotReject(async ()=>{
            await fs.access(EXISTING_FOLDER_NEW_LINK_PATH);
        });
    });

    it('test work, pass empty array', ()=>{
        assert.doesNotReject(async ()=>{
            await write_file_work([]);
        });
    });

    it('test work, pass files with success', ()=>{
        let write_file_revert = write_file.__set__('writeFile', async ()=>{
            return;
        });

        let write_link_revert = write_file.__set__('writeLink', async ()=>{
            return;
        });
        assert.doesNotReject(async ()=>{
            await write_file_work(TEST_FILE);
        });

        write_file_revert();
        write_link_revert();
    });

    it('test work, pass files with error to hit logger', ()=>{
        let write_file_revert = write_file.__set__('writeFile', async ()=>{
            throw new Error('fail!');
        });

        assert.doesNotReject(async ()=>{
            await write_file_work(TEST_FILE);
        });

        write_file_revert();
    });

    describe('Test writeFiles', ()=>{
        let revert;
        beforeEach(()=>{
            revert = write_file.__set__('work', async (files)=>{
                return;
            });
        });

        afterEach(()=>{
            revert();
        });

        it('test writeFiles, do not cause chunking', ()=>{
            assert.doesNotReject(async ()=>{
                await write_files_func(TEST_FILE);
            });
        });

        it('test writeFiles, cause chunking', ()=>{
            let chunk_revert = write_file.__set__('CHUNK_SIZE', 1);

            assert.doesNotReject(async ()=>{
                await write_files_func(TEST_FILES);
            });

            chunk_revert();
        });
    });

});