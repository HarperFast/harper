'use strict';

const test_utils = require('../../../../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();
const {
    createMockFS,
    deepClone,
    makeTheDir,
    getMockFSPath,
    mochaAsyncWrapper,
    tearDownMockFS
} = test_utils;

const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const fsDeleteRecordsBefore = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecordsBefore');
const fsDeleteRecords_rw = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
const fs = require('graceful-fs');
const moment = require('moment');
const log = require('../../../../../utility/logging/harper_logger');

const TEST_FS_DIR = getMockFSPath();
const TEST_SCHEMA = 'test';
const TEST_SCHEMA_PATH = path.join(TEST_FS_DIR, TEST_SCHEMA);
const HASH_ATTRIBUTE = 'id';
const BAD_DIR_PATH = path.join(TEST_FS_DIR, '/tmp/zaphodbeeblebrox');
let TEST_TABLE_DOG_PATH;
const TEST_DATA_DOG = [
    {
        "name":"Frank",
        "id":"1",
        "age":5
    },
    {
        "name":"Bill",
        "id":"2",
        "age":4
    }
];
const TEST_DATA_CAT = [
    {
        "name":"Eddie",
        "id":"1",
        "age":4
    }
];
const TEST_DOG_HASH_VALUES = TEST_DATA_DOG.map(data => data[HASH_ATTRIBUTE]);
const TEST_TABLE_DOG = 'dog';
const TEST_TABLE_CAT = 'cat';
const TOMORROW_TIME = moment().add(1, 'days');
const YESTERDAY_TIME = moment().subtract(1, 'days');
const NOW = moment();
const ISO_8601_FORMAT = 'YYYY-MM-DD';
const NOW_FORMATTED = NOW.format(ISO_8601_FORMAT);

const JSON_OBJECT_DELETE_BEFORE = {
    "operation": "delete_files_before",
    "date": `${NOW_FORMATTED}`,
    "schema": `${TEST_SCHEMA}`,
    "table": `${TEST_TABLE_DOG}`
};

function setup() {
    const test_data_clone_dog = deepClone(TEST_DATA_DOG);
    const test_data_clone_cat = deepClone(TEST_DATA_CAT);

    const dog_instance = createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_DOG, test_data_clone_dog);
    const cat_instance = createMockFS(HASH_ATTRIBUTE, TEST_SCHEMA, TEST_TABLE_CAT, test_data_clone_cat);

    TEST_TABLE_DOG_PATH = dog_instance.paths.table_dir;

    return {
        [TEST_TABLE_DOG]: dog_instance,
        [TEST_TABLE_CAT]: cat_instance
    };
}

describe('Tests for file system module fsDeleteRecordsBefore', () => {
    let sandbox = sinon.createSandbox();
    let search_stub = sandbox.stub();
    let log_error_stub;

    before(() => {

        tearDownMockFS();
        log_error_stub = sandbox.stub(log, 'error');
        fsDeleteRecordsBefore.__set__('getBasePath', test_utils.getMockFSPath);
        fsDeleteRecordsBefore.__set__('fsDeleteRecords', fsDeleteRecords_rw);
        fsDeleteRecords_rw.__set__('BASE_PATH', test_utils.getMockFSPath());
        fsDeleteRecords_rw.__set__('fsSearchByHash', search_stub);
    });

    after(() => {
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecordsBefore');
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
        sandbox.restore();
    });

    describe('Test deleteFilesInPath', () => {
        let test_data;
        let files_to_check;
        let deleteFilesInPath;

        before(() => {
            deleteFilesInPath = fsDeleteRecordsBefore.__get__('deleteFilesInPath');
        });

        beforeEach(() => {
            test_data = setup();
            files_to_check = [...test_data[TEST_TABLE_DOG][0].paths.files, ...test_data[TEST_TABLE_DOG][1].paths.files ];
            search_stub.resolves(TEST_DATA_DOG);
        });

        afterEach(() => {
            test_data = undefined;
            files_to_check = undefined;
            search_stub.reset();
            tearDownMockFS();
        });

        it('Nominal path of deleteFilesInPath, test against DOG table', mochaAsyncWrapper(async () => {
              await deleteFilesInPath(TEST_SCHEMA, TEST_TABLE_DOG, TEST_TABLE_DOG_PATH, TOMORROW_TIME);

              for (let i = 0; i < files_to_check.length; i++) {
                  assert.equal(fs.existsSync(files_to_check[i]), false, `FAILURE: file ${files_to_check[i]} still exists.`);
              }
          }));

        it('Test invalid directory parameter.  Expect no files to be deleted.', mochaAsyncWrapper(async () => {
            await deleteFilesInPath(TEST_SCHEMA, TEST_TABLE_DOG, null, TOMORROW_TIME)
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        }));

        it('Test invalid date parameter.  Expect no files to be deleted.', mochaAsyncWrapper(async () => {
            let files_to_check = [...test_data[TEST_TABLE_DOG][0].paths.files, ...test_data[TEST_TABLE_DOG][1].paths.files];
            await deleteFilesInPath(TEST_SCHEMA, TEST_TABLE_DOG, TEST_TABLE_DOG_PATH, "2011-01-01")
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        }));

        it('Test invalid schema parameter.  Expect no files to be deleted.', mochaAsyncWrapper(async () => {
            let files_to_check = [...test_data[TEST_TABLE_DOG][0].paths.files, ...test_data[TEST_TABLE_DOG][1].paths.files];
            await deleteFilesInPath(null, TEST_TABLE_DOG, TEST_TABLE_DOG_PATH, TOMORROW_TIME)
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        }));

        it('Test invalid table parameter.  Expect no files to be deleted.', mochaAsyncWrapper(async () => {
            await deleteFilesInPath(TEST_SCHEMA, null, TEST_TABLE_DOG_PATH, TOMORROW_TIME)
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        }));

        it('Test with table not found in the schema.  Expect no files to be deleted.', mochaAsyncWrapper(async () => {
            await deleteFilesInPath(TEST_SCHEMA, "Fish", TEST_TABLE_DOG_PATH, TOMORROW_TIME);
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        }));
    });

    describe('Test deleteFilesBefore', () => {
        let test_data = undefined;
        let files_to_check;

        before(() => {
            fsDeleteRecords_rw.__set__('fsSearchByHash', search_stub);
        });

        beforeEach(() => {
            search_stub.resolves(TEST_DATA_DOG);
            test_data = setup();
            files_to_check = [...test_data[TEST_TABLE_DOG][0].paths.files, ...test_data[TEST_TABLE_DOG][1].paths.files ];
        });

        afterEach(() => {
            test_data = undefined;
            files_to_check = undefined;
            tearDownMockFS();
        });

        it('deleteFilesBefore with yesterday as a time stamp, expect no files removed', mochaAsyncWrapper(async () => {
            let request = deepClone(JSON_OBJECT_DELETE_BEFORE);
            request.date = YESTERDAY_TIME.format(ISO_8601_FORMAT);
            //search_stub.resolves([TEST_DATA_DOG[0]]);
            await fsDeleteRecordsBefore(request);
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        }));

        it('Nominal path of deleteFilesBefore with 1 directory', mochaAsyncWrapper(async () => {
           let files_to_check = [...test_data[TEST_TABLE_CAT][0].paths.files, ...test_data[TEST_TABLE_CAT][0].paths.journals];
           let request = deepClone(JSON_OBJECT_DELETE_BEFORE);
           request.table = TEST_TABLE_CAT;
           request.date = TOMORROW_TIME.format(ISO_8601_FORMAT);
           search_stub.resolves(TEST_DATA_CAT);
           await fsDeleteRecordsBefore(request);
           for (let i = 0; i < files_to_check.length; i++) {
               assert.equal(fs.existsSync(files_to_check[i]), false, `FAILURE: file ${files_to_check[i]} still exists.`);
           }
        }));

        it('Nominal path of deleteFilesBefore on the dog table', mochaAsyncWrapper(async () => {
           let request = deepClone(JSON_OBJECT_DELETE_BEFORE);
           request.date = TOMORROW_TIME.format(ISO_8601_FORMAT);
           await fsDeleteRecordsBefore(request);
           for (let i = 0; i < files_to_check.length; i++) {
               assert.equal( fs.existsSync(files_to_check[i]), false, `FAILURE: file ${files_to_check[i]} still exists.`);
           }
        }));

        it('Call deleteFilesBefore with valid date strings, nothing removed', mochaAsyncWrapper(async () => {
            let request = deepClone(JSON_OBJECT_DELETE_BEFORE);
            request.date = '2011-01-11';
            await fsDeleteRecordsBefore(request);
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} was deleted.`);
            }
        }));

        // Test date with Times included
        it('Call with valid date/time, nothing removed', mochaAsyncWrapper(async () => {
            let request = deepClone(JSON_OBJECT_DELETE_BEFORE);
            request.date = '2011-01-11T17:45:55+00:00';
            await fsDeleteRecordsBefore(request);
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} was deleted.`);
            }
        }));

        //Test Epoc
        it('Call with Epoc', mochaAsyncWrapper(async () => {
            let request = deepClone(JSON_OBJECT_DELETE_BEFORE);
            request.date = '1969-01-01';
            await fsDeleteRecordsBefore(request);
            for (let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} was deleted.`);
            }
        }));
    });

    describe('Test doesDirectoryExist', () => {
        let doesDirectoryExist;

        before(() => {
            doesDirectoryExist = fsDeleteRecordsBefore.__get__('doesDirectoryExist');
            setup();
        });

        after(() => {
            tearDownMockFS();
            search_stub.reset();
        });

        it('Nominal path with directory that exists.', mochaAsyncWrapper(async () => {
            let doesExist = await doesDirectoryExist(TEST_TABLE_DOG_PATH);
            assert.equal(doesExist, true);
        }));

        it('Test non existent directory', mochaAsyncWrapper(async () => {
            let doesExist = await doesDirectoryExist(BAD_DIR_PATH);
            assert.equal(doesExist, false);
        }));

        it('Test null directory', mochaAsyncWrapper(async () => {
            let doesExist = await doesDirectoryExist(null);
            assert.equal(doesExist, false);
        }));
    });

    describe('Test inspectHashAttributeDir', () => {
        let inspectHashAttributeDir;
        let found_hashes_to_remove;

        before(() => {
            found_hashes_to_remove = [];
            inspectHashAttributeDir = fsDeleteRecordsBefore.__get__('inspectHashAttributeDir');
        });

        beforeEach(() => {
            setup();
        });

        afterEach(() => {
            found_hashes_to_remove = [];
            search_stub.reset();
            tearDownMockFS();
        });

        it('Nominal path to search the dog directory.  Should find both ids in TEST_DATA', mochaAsyncWrapper(async () => {
            let hash_attribute_dir_path = path.join(TEST_SCHEMA_PATH, TEST_TABLE_DOG, HASH_ATTRIBUTE);
            await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
            assert.equal(found_hashes_to_remove.length, 2);
        }));

        it('Nominal path to search the cat directory.  Should find 1 id TEST_DATA', mochaAsyncWrapper(async () => {
            let hash_attribute_dir_path = path.join(TEST_SCHEMA_PATH, TEST_TABLE_CAT, HASH_ATTRIBUTE);
            await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
            assert.equal(found_hashes_to_remove.length, 1);
        }));

        it('Nominal path to search the bird directory.  Should find 0 ids', mochaAsyncWrapper(async () => {
            //Setup empty bird table
            const TEST_TABLE_BIRD = 'bird';
            const TEST_TABLE_BIRD_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_BIRD);
            makeTheDir(TEST_TABLE_BIRD_PATH);
            makeTheDir(path.join(TEST_TABLE_BIRD_PATH, HASH_ATTRIBUTE));

            let hash_attribute_dir_path = path.join(TEST_SCHEMA_PATH, TEST_TABLE_BIRD, HASH_ATTRIBUTE);
            await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
            assert.equal(found_hashes_to_remove.length, 0);
        }));

        it('Create a later time id file in CAT table simulating an update.  Should find 0 ids.', mochaAsyncWrapper(async () => {
            let hash_attribute_dir_path = path.join(TEST_SCHEMA_PATH, TEST_TABLE_CAT, HASH_ATTRIBUTE);
            let new_file_path = path.join(hash_attribute_dir_path, TEST_DATA_CAT[0][HASH_ATTRIBUTE], TOMORROW_TIME.valueOf().toString() + '.hdb');
            fs.writeFileSync(new_file_path, "blah blah");
            await inspectHashAttributeDir(NOW.add(1, "hours").valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
            assert.equal(found_hashes_to_remove.length, 0);
        }));

        it('Pass invalid directory, should return 0 ids.', mochaAsyncWrapper(async () => {
            await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), BAD_DIR_PATH, found_hashes_to_remove);
            assert.equal(found_hashes_to_remove.length, 0);
        }));

        it('Pass invalid date, should return 0 ids.', mochaAsyncWrapper(async () => {
            await inspectHashAttributeDir(0, TEST_TABLE_DOG, found_hashes_to_remove);
            assert.equal(found_hashes_to_remove.length, 0);
        }));
    });

   describe('Test isFileTimeBeforeParameterTime', () => {
        let isFileTimeBeforeParameterTime;

        before(() => {
            isFileTimeBeforeParameterTime = fsDeleteRecordsBefore.__get__('isFileTimeBeforeParameterTime');
        });

        it('Nominal path of isFileTimeBeforeParameterTime, tomorrow is greater than now expect true', () => {
            let now = moment();
            let tomorrow = moment().add(1, "days").valueOf();
            let now_file_name = now.valueOf().toString() + '.hdb';
            let result = isFileTimeBeforeParameterTime(tomorrow, now_file_name);
            assert.equal(result, true);
        });

        it('Nominal path of isFileTimeBeforeParameterTime, yesterday is less than now expect false', () => {
            let now = moment();
            let yesterday = moment().subtract(1, "days").valueOf();
            let now_file_name = now.valueOf().toString() + '.hdb';
            let result = isFileTimeBeforeParameterTime(yesterday, now_file_name);
            assert.equal(result, false);
        });

        it('test isFileTimeBeforeParameterTime close times', () => {
            let now = moment();
            let now_plus_ms = moment(now).add(1, "ms").valueOf();
            let now_file_name = now.valueOf().toString() + '.hdb';
            let result = isFileTimeBeforeParameterTime(now_plus_ms, now_file_name);
            assert.equal(result, true);
        });

        it('test isFileTimeBeforeParameterTime with date passed as string', () => {
            let now = moment();
            let tomorrow = moment().add(1, "days").valueOf();
            let now_file_name = now.valueOf().toString() + '.hdb';
            let result = isFileTimeBeforeParameterTime(tomorrow.toString(), now_file_name);
            assert.equal(result, false);
        });

        it('test isFileTimeBeforeParameterTime with date passed as null', () => {
            let now = moment();
            let now_file_name = now.valueOf().toString() + '.hdb';
            let result = isFileTimeBeforeParameterTime(null, now_file_name);
            assert.equal(result, false);
        });

        it('test isFileTimeBeforeParameterTime with file passed as null', () => {
            let tomorrow = moment().add(1, "days").valueOf();
            let result = isFileTimeBeforeParameterTime(tomorrow, null);
            assert.equal(result, false);
        });

        it('test isFileTimeBeforeParameterTime with file passed as empty string' , () => {
            let tomorrow = moment().add(1, "days").valueOf();
            let result = isFileTimeBeforeParameterTime(tomorrow, "");
            assert.equal(result, false);
        });
    });

    describe('Test removeFiles', () => {
        let removeFiles;
        let files_to_remove;
        let test_data = null;

        before(() => {
            removeFiles = fsDeleteRecordsBefore.__get__('removeFiles');
            search_stub.resolves(TEST_DATA_DOG);
        });

        beforeEach(() => {
            test_data = setup();
            files_to_remove = [
                ...test_data[TEST_TABLE_DOG][0].paths.files,
                ...test_data[TEST_TABLE_DOG][0].paths.journals,
                ...test_data[TEST_TABLE_DOG][1].paths.files,
                ...test_data[TEST_TABLE_DOG][1].paths.journals
            ];
        });

        afterEach(() => {
            test_data = undefined;
            files_to_remove = undefined;
            search_stub.reset();
            tearDownMockFS();
        });

        it('Nominal path of removeFiles on dog table', mochaAsyncWrapper(async () => {
            for (let file of files_to_remove) {
                assert.equal(fs.existsSync(file), true, `SETUP FAILURE: File ${file} was not created.`);
            }
            await removeFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE, TEST_DOG_HASH_VALUES);
            for (let file of files_to_remove) {
                assert.equal(fs.existsSync(file), false, `FAILURE: File ${file} still exists.`);
            }
        }));

        it('removeFiles with empty files parameter', mochaAsyncWrapper( async () => {
            let test_err_result = await test_utils.testError(removeFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE, []), "Hash values can't be blank");

            assert.strictEqual(test_err_result, true);
        }));
    });


    describe('Test removeIDFiles', () => {
        let removeIDFiles;
        let test_values;

        before(() => {
            removeIDFiles = fsDeleteRecordsBefore.__get__('removeIDFiles');
        });

        beforeEach(() => {
            test_values = setup();
        });

        afterEach(() => {
            test_values = undefined;
            tearDownMockFS();
        });

        it('Nominal path of removeIDFiles against dog table.', mochaAsyncWrapper(async () => {
             let journal_files = [...test_values[TEST_TABLE_DOG][0].paths.journals, ...test_values[TEST_TABLE_DOG][1].paths.journals];
             let ids = test_values[TEST_TABLE_DOG].map(a => a[HASH_ATTRIBUTE]);
             for (let i = 0; i < journal_files.length; i++) {
                 assert.equal(fs.existsSync(journal_files[i]), true, `SETUP FAILURE: file ${journal_files[i]} was not created.`);
             }
             await removeIDFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE, ids);
             for (let i = 0; i < journal_files.length; i++) {
                 assert.equal(fs.existsSync(journal_files[i]), false, `FAILURE: file ${journal_files[i]} still exists.`);
             }
        }));

        it('Try to pass system schema.', mochaAsyncWrapper(async () => {
            let journal_files = [...test_values[TEST_TABLE_DOG][0].paths.journals, ...test_values[TEST_TABLE_DOG][1].paths.journals];
            await removeIDFiles('system', TEST_TABLE_DOG, journal_files);
            for (let i = 0; i < journal_files.length; i++) {
                assert.equal(fs.existsSync(journal_files[i]), true, `FAILURE: file ${journal_files[i]} does not exist.`);
            }
        }));
    });

    describe('Test getDirectoriesInPath', () => {
        let getDirectoriesInPath;

        before(() => {
            setup();
            getDirectoriesInPath = fsDeleteRecordsBefore.__get__('getDirectoriesInPath');
            const ATTRIBUTE_TIME_NAME = moment().subtract(6, 'hours').valueOf();
            const TEST_FILE_NAME = `${ATTRIBUTE_TIME_NAME}.hdb`;
            const FILE_CONTENTS = "Name";
            fs.writeFileSync(path.join(TEST_TABLE_DOG_PATH, TEST_FILE_NAME), FILE_CONTENTS);
        });

        after(() => {
            tearDownMockFS();
        });

        // There should be 2 directories, each with 1 file, and 1 text file in the current directory
        it('Nominal path of getDirectoriesInPath', mochaAsyncWrapper(async () => {
            let list_dir_results = [];
            await getDirectoriesInPath(TEST_TABLE_DOG_PATH, list_dir_results, TOMORROW_TIME);
            assert.equal(Object.keys(list_dir_results).length, 9);
        }));

        it('test getDirectoriesInPath with a null path', mochaAsyncWrapper(async () => {
            let list_dir_results = [];
            await getDirectoriesInPath(null, list_dir_results, TOMORROW_TIME);
            assert.equal(Object.keys(list_dir_results).length, 0);
        }));

        it('test getDirectoriesInPath with a space as path', mochaAsyncWrapper(async () => {
            let list_dir_results = [];
            await getDirectoriesInPath(' ', list_dir_results, TOMORROW_TIME);
            assert.equal(Object.keys(list_dir_results).length, 0);
        }));

        it('test getDirectoriesInPath with an invalid path', mochaAsyncWrapper(async () => {
            let list_dir_results = [];
            await getDirectoriesInPath(BAD_DIR_PATH, list_dir_results, TOMORROW_TIME);
            assert.equal(Object.keys(list_dir_results).length, 0);
        }));

        it('test getDirectoriesInPath with 1 directory found', mochaAsyncWrapper(async () => {
            //Setup empty bird table
            const TEST_TABLE_BIRD = 'bird';
            const TEST_TABLE_BIRD_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_BIRD);
            makeTheDir(TEST_TABLE_BIRD_PATH);
            makeTheDir(path.join(TEST_TABLE_BIRD_PATH, HASH_ATTRIBUTE));

            let list_dir_results = [];
            await getDirectoriesInPath(TEST_TABLE_BIRD_PATH, list_dir_results, TOMORROW_TIME);
            assert.equal(Object.keys(list_dir_results).length, 1);
        }));
    });
});
