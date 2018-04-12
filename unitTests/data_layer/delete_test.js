"use strict";

const test_utils = require('../test_utils');
// try to move to /bin directory so our properties reader doesn't explode.
test_utils.preTestPrep();

const path = require('path');
const assert = require('assert');
const sinon = require('sinon');
const rewire = require('rewire');
const delete_rewire = rewire('../../data_layer/delete');
const fs = require('graceful-fs');
const moment = require('moment');
const global_schema = require('../../utility/globalSchema');
const search = require('../../data_layer/search');

const ISO_8601_FORMAT = 'YYYY-MM-DD';
const NOW_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ';
const ATTRIBUTE_1_INSTANCE_NAME = 'FrankThePug';
const ATTRIBUTE_2_INSTANCE_NAME = 'Bill';
const ATTRIBUTE_3_INSTANCE_NAME = 'Eddie';
const ATTRIBUTE_AGE_INSTANCE_VAL = '3';
const TEST_FILE_NAME_1 = `${ATTRIBUTE_1_INSTANCE_NAME}.hdb`;
const TEST_FILE_NAME_2 = `${ATTRIBUTE_2_INSTANCE_NAME}.hdb`;
const TEST_FILE_NAME_3 = `${ATTRIBUTE_3_INSTANCE_NAME}.hdb`;
const TEST_AGE_FILE_NAME_3 = `${ATTRIBUTE_AGE_INSTANCE_VAL}.hdb`;
const FILE_CONTENTS = "Name";
const DELETE_MOD_BASE_PATH_NAME = 'hdb_path';
const TEST_ATTRIBUTE_NAME = 'Name';
const TEST_ATTRIBUTE_AGE = 'Age';

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
const TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH = path.join(TABLE_1_ATTRIBUTE_PATH, ATTRIBUTE_1_INSTANCE_NAME);
const TABLE_1_ATTRIBUTE_HASH_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, TEST_FILE_NAME_1);
const TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_1);

const TABLE_1_ATTRIBUTE_AGE_PATH = path.join(TEST_TABLE_1_PATH, TEST_ATTRIBUTE_AGE);
const TABLE_1_ATTRIBUTE_AGE_HASH_DIRECTORY_PATH = path.join(TEST_TABLE_1_HASH, TEST_ATTRIBUTE_AGE);
const TABLE_1_ATTRIBUTE_AGE_INSTANCE_DIRECTORY_PATH = path.join(TABLE_1_ATTRIBUTE_AGE_PATH, ATTRIBUTE_AGE_INSTANCE_VAL);
const TABLE_1_ATTRIBUTE_AGE_HASH_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_AGE_HASH_DIRECTORY_PATH, TEST_AGE_FILE_NAME_3);
const TABLE_1_ATTRIBUTE_AGE_INSTANCE_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_AGE_INSTANCE_DIRECTORY_PATH, TEST_AGE_FILE_NAME_3);

const TEST_TABLE_2 = 'test_dir2';
const TEST_TABLE_2_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_2);
const TEST_TABLE_2_HASH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_2, HDB_HASH_FOLDER_NAME);
const TABLE_2_ATTRIBUTE_PATH = path.join(TEST_TABLE_2_PATH, TEST_ATTRIBUTE_NAME);
const TABLE_2_ATTRIBUTE_HASH_DIRECTORY_PATH = path.join(TEST_TABLE_2_HASH, TEST_ATTRIBUTE_NAME);
const TABLE_2_ATTRIBUTE_INSTANCE_DIRECTORY_PATH = path.join(TABLE_2_ATTRIBUTE_PATH, ATTRIBUTE_1_INSTANCE_NAME);
const TABLE_2_ATTRIBUTE_HASH_FILE_PATH = path.join(TABLE_2_ATTRIBUTE_HASH_DIRECTORY_PATH, TEST_FILE_NAME_2);
const TABLE_2_ATTRIBUTE_INSTANCE_FILE_PATH = path.join(TABLE_2_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_2);

const TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH, TEST_FILE_NAME_3);
const TABLE_1_ATTRIBUTE_2_INSTANCE_FILE_PATH = path.join(TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_3);

const TEST_TABLE_3 = 'test_dir3';
const TEST_TABLE_3_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_3);

const TOMORROW_TIME = moment().add(1, 'days');
const YESTERDAY_TIME = moment().subtract(1, 'days');
const NOW = moment();

const SEARCH_RESULT_OBJECT = {};

SEARCH_RESULT_OBJECT[TEST_ATTRIBUTE_NAME] = ATTRIBUTE_1_INSTANCE_NAME;
let now_formatted = NOW.format(ISO_8601_FORMAT);
const TEST_DELETE_BEFORE_REQUEST = {
    "operation": "delete_files_before",
    "date": `${now_formatted}`,
    "schema": `${TEST_SCHEMA}`,
    "table": `${TEST_TABLE_1}`,
    "hdb_user": {},
    "hdb_auth_header": "Basic abcdefg"
}

global.hdb_schema = {
    "test": {
        "breed": {
            "hash_attribute": "id",
            "id": "19888dcb-68ad-4a85-bf93-ad1e8d4b6fc4",
            "name": "breed",
            "schema": "dev",
            "attributes": []
        },
        "test_dir1": {
            "hash_attribute": `${TEST_ATTRIBUTE_NAME}`,
            "id": "8650f230-be55-4455-8843-55bcfe7f61c4",
            "name": "test_dir1",
            "schema": "test",
            "attributes": [
                {
                    "attribute": `${TEST_ATTRIBUTE_NAME}`
                }
            ]
        }
    },
    "system": {
        "hdb_table": {
            "hash_attribute": "id",
            "name": "hdb_table",
            "schema": "system",
            "residence": [
                "*"
            ],
            "attributes": [
                {
                    "attribute": "id"
                },
                {
                    "attribute": "name"
                },
                {
                    "attribute": "hash_attribute"
                },
                {
                    "attribute": "schema"
                }
            ]
        },
        "hdb_drop_schema": {
            "hash_attribute": "id",
            "name": "hdb_drop_schema",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_attribute": {
            "hash_attribute": "id",
            "name": "hdb_attribute",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_schema": {
            "hash_attribute": "name",
            "name": "hdb_schema",
            "schema": "system",
            "residence": [
                "*"
            ],
            "attributes": [
                {
                    "attribute": "name"
                },
                {
                    "attribute": "createddate"
                }
            ]
        },
        "hdb_user": {
            "hash_attribute": "username",
            "name": "hdb_user",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_role": {
            "hash_attribute": "id",
            "name": "hdb_user",
            "schema": "system",
            "residence": [
                "*"
            ]
        },
        "hdb_license": {
            "hash_attribute": "license_key",
            "name": "hdb_license",
            "schema": "system"
        },
        "hdb_nodes": {
            "hash_attribute": "name",
            "residence": [
                "*"
            ]
        },
        "hdb_queue": {
            "hash_attribute": "id",
            "name": "hdb_queue",
            "schema": "system",
            "residence": [
                "*"
            ]
        }
    }
}

const FOUND_FILES_IN_TABLE_1 = {
    "/Users/elipalmer/harperdb/bin/test/test_dir1/Age/3/3.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/Name/FrankThePug/Eddie.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/Name/FrankThePug/FrankThePug.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/__hdb_hash/Age/3.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/__hdb_hash/Name/Eddie.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/__hdb_hash/Name/FrankThePug.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    }
}

const FOUND_FILES_IN_SCHEMA = {
    "/Users/elipalmer/harperdb/bin/test/Bill.hdb": {
        "nlink": 1,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/Age/3/3.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/Name/FrankThePug/Eddie.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/Name/FrankThePug/FrankThePug.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/__hdb_hash/Age/3.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/__hdb_hash/Name/Eddie.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir1/__hdb_hash/Name/FrankThePug.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir2/Name/FrankThePug/Bill.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    },
    "/Users/elipalmer/harperdb/bin/test/test_dir2/__hdb_hash/Name/Bill.hdb": {
        "nlink": 2,
        "mtimeMs": NOW.valueOf(),
        "mtime": NOW.format(NOW_FORMAT)
    }
}

const DELETE_OBJECT = {
    "operation": "delete",
    "table": "test_dir1",
    "schema": "test",
    "hash_values": [
        FILE_CONTENTS
    ],
    "hdb_user": {
        "active": true,
        "role": {
            "id": "dc52dc65-efc7-4cc4-b3ed-04a98602c0b2",
            "permission": {
                "super_user": true
            },
            "role": "super_user"
        },
        "username": "eli"
    },
    "hdb_auth_header": "Basic ZWxpOnBhc3M="
};

function setup() {

    // Setup table 1
    fs.mkdirSync(TEST_SCHEMA_PATH);
    fs.mkdirSync(TEST_TABLE_1_PATH);
    fs.mkdirSync(TEST_TABLE_1_HASH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_AGE_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_HASH_DIRECTORY_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_INSTANCE_DIRECTORY_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_AGE_HASH_DIRECTORY_PATH);
    fs.mkdirSync(TABLE_1_ATTRIBUTE_AGE_INSTANCE_DIRECTORY_PATH);
    fs.writeFileSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH);
    fs.linkSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH, TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH);
    fs.writeFileSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH);
    fs.linkSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH, TABLE_1_ATTRIBUTE_2_INSTANCE_FILE_PATH);
    fs.writeFileSync(TABLE_1_ATTRIBUTE_AGE_HASH_FILE_PATH);
    fs.linkSync(TABLE_1_ATTRIBUTE_AGE_HASH_FILE_PATH, TABLE_1_ATTRIBUTE_AGE_INSTANCE_FILE_PATH);

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
        try {
            files = fs.readdirSync(target_path);
            files.forEach(function (file, index) {
                let curPath = path.join(target_path, file);
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    tearDown(curPath);
                } else { // delete file
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(target_path);
        } catch (e) {
            console.error(e);
        }
    }
};

describe('Test deleteFilesBefore', function () {
    beforeEach(function () {
        try {
            setup();
            delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        } catch (e) {
            console.error(e);
        }
    });
    afterEach(function () {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch (e) {
            console.error(e);
        }
    });
    it('deleteFilesBefore with yesterday as a time stamp', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = YESTERDAY_TIME.format(ISO_8601_FORMAT);
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(msg, `Deleted 0 files`);
                assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    it('Nominal path of deleteFilesBefore with 1 directory', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.table = TEST_TABLE_2;
        request.date = TOMORROW_TIME.format(ISO_8601_FORMAT);
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(msg, `Deleted 2 files`);
                assert.equal(fs.existsSync(TABLE_2_ATTRIBUTE_HASH_FILE_PATH), false);
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    it('Nominal path of deleteFilesBefore with 2 directories', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = TOMORROW_TIME.format(ISO_8601_FORMAT);
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(msg, `Deleted 6 files`);
                assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    it('Call deleteFilesBefore with null date', function (done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = null;
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err.message, 'Invalid date.');
                done();
            } catch(e) {
                done(e);
            }
        });
    });

    it(`Call deleteFileBefore with null schema`, function(done) {
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.schema = null;
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err.message, "Invalid schema.");
                done();
            } catch(e) {
                done(e);
            }
        });
    });

    it(`Call deleteFileBefore with null table`, function(done) {
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.table = null;
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err.message, "Invalid table.");
                done();
            } catch(e) {
                done(e);
            }
        });
    });

    it('Call deleteFilesBefore with valid date strings', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '2011-01-11';
        // Test nominal case
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err, null);
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    // Test date with Times included
    it('Call with valid date/time', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '2011-01-11T17:45:55+00:00';
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err, null);
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    // Test leap year silliness
    it('Call with invalid leap year', function(done) {
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '2011-02-29';
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err.message, 'Invalid date, must be in ISO-8601 format.');
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    //Test Epoc
    it('Call with Epoc', function(done) {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '1969-01-01';
        delete_rewire.deleteFilesBefore(request, function del(err, msg) {
            try {
                assert.equal(err, null);
                done();
            } catch(e) {
                done(e);
            }
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
    it('Nominal path with directory that exists.', test_utils.mochaAsyncWrapper(async () => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let doesExist = await doesDirectoryExist(TEST_TABLE_1_PATH);
        assert.equal(doesExist, true);
    }));
    //
    it('Test non existent directory', test_utils.mochaAsyncWrapper(async () => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let doesExist = await doesDirectoryExist('/tmp/howdyho');
        assert.equal(doesExist, false);
    }));
    it('Test null directory', test_utils.mochaAsyncWrapper(async () => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let doesExist = await doesDirectoryExist(null);
        assert.equal(doesExist, false);
    }));
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
    it('Nominal path of removeFiles', test_utils.mochaAsyncWrapper(async () => {
        let removed_count = await removeFiles(TOMORROW_TIME, FOUND_FILES_IN_TABLE_1);
        assert.equal(removed_count, 6);
        for( let file in FOUND_FILES_IN_TABLE_1) {
            assert.equal(fs.existsSync(file), false, `File ${file} still exists.`);
        }
    }));
    it('removeFiles with files parameter having 1 bad filename', test_utils.mochaAsyncWrapper(async () => {
        let files_copy = test_utils.deepClone(FOUND_FILES_IN_TABLE_1);
        let temp = "/Users/elipalmer/harperdb/bin/test/test_dir1/Age/3/3.hdb";
        Object.defineProperty(files_copy, './badpath.hdb',
            Object.getOwnPropertyDescriptor(files_copy, temp));
        delete files_copy[temp];
        let removed_count = await removeFiles(TOMORROW_TIME, files_copy);
        assert.equal(removed_count, 5);
        for( let file in files_copy) {
            if(file !== temp) {
                assert.equal(fs.existsSync(file), false, `File ${file} still exists.`);
            }
        }
    }));
    it('removeFiles with empty files parameter', test_utils.mochaAsyncWrapper(async () => {
        let local_files = [];
        let removed_count = await removeFiles(TOMORROW_TIME, local_files);
        assert.equal(removed_count, 0);
    }));
    it('removeFiles with all invalid files parameter', test_utils.mochaAsyncWrapper(async () => {
        let files_copy = test_utils.deepClone(FOUND_FILES_IN_TABLE_1);
        let counter = 0;
        for( let file in files_copy) {
            Object.defineProperty(files_copy, './badpath' + counter + '.hdb',
                Object.getOwnPropertyDescriptor(files_copy, file));
            delete files_copy[file];
            counter++;
        }
        let removed_count = await removeFiles(TOMORROW_TIME, files_copy);
        assert.equal(removed_count, 0);
        assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
        assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
    }));
    it('removeFiles with null files parameter', test_utils.mochaAsyncWrapper(async () => {
        let removed_count = await removeFiles(TOMORROW_TIME, null);
        assert.equal(removed_count, 0);
        assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
        assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
    }));
    it('removeFiles with null date parameter', test_utils.mochaAsyncWrapper(async () => {
        let removed_count = await removeFiles(null, FOUND_FILES_IN_SCHEMA);
        assert.equal(removed_count, 0);
        for( let file in FOUND_FILES_IN_SCHEMA) {
            assert.equal(fs.existsSync(file), true, `File ${file} was deleted for some reason.`);
        }
    }));
    it('removeFiles with yesterday as a date', test_utils.mochaAsyncWrapper(async () => {
        let removed_count = await removeFiles(YESTERDAY_TIME, FOUND_FILES_IN_SCHEMA);
        assert.equal(removed_count, 0);
        for( let file in FOUND_FILES_IN_SCHEMA) {
            assert.equal(fs.existsSync(file), true, `File ${file} was deleted for some reason.`);
        }
    }));
});

describe('Test getFilesInDirectories', function () {
    let getFilesInDirectories = delete_rewire.__get__('getFilesInDirectories');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
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
    it('Nominal path of getFilesInDirectories', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = Object.create(null);
        await getFilesInDirectories(TEST_SCHEMA_PATH, list_dir_results);
        assert.equal(Object.keys(list_dir_results).length, 9);
    }));

    it('test getFilesInDirectories with a null path', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = Object.create(null);
        await getFilesInDirectories(null, list_dir_results);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));

    it('test getFilesInDirectories with a space as path', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = Object.create(null);
        await getFilesInDirectories(' ', list_dir_results);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));

    it('test getFilesInDirectories with an invalid path', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = Object.create(null);
        await getFilesInDirectories('../askdsdfsadc', list_dir_results);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));

    it('test getFilesInDirectories with no directories found', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = Object.create(null);
        await getFilesInDirectories(TEST_TABLE_3_PATH, list_dir_results);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));
});

describe('Test deleteRecord', function () {
    let global_schema_stub = sinon.stub(global_schema, "getTableSchema").yields("", null);
    let search_stub = sinon.stub(search, "searchByHash").yields("", [SEARCH_RESULT_OBJECT]);

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
    it('Nominal path for delete Record', function (done) {
        delete_rewire.__set__('base_path', BASE);
        delete_rewire.delete(DELETE_OBJECT, function(err, results) {
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('test deleteRecord with bad deleteObject parameter', function (done) {
        delete_rewire.__set__('base_path', BASE);
        delete_rewire.delete(null, function(err, results) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('test deleteRecord with bad schema in deleteObject parameter', function (done) {
        delete_rewire.__set__('base_path', BASE);
        let del_obj = test_utils.deepClone(DELETE_OBJECT);
        del_obj.schema = 'hootiehoo';
        delete_rewire.delete(del_obj, function(err, results) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('test deleteRecord with bad table in deleteObject parameter', function (done) {
        delete_rewire.__set__('base_path', BASE);
        let del_obj = test_utils.deepClone(DELETE_OBJECT);
        del_obj.table = 'hootiehoo';
        delete_rewire.delete(del_obj, function(err, results) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('test deleteRecord with search returning no results', function (done) {
        delete_rewire.__set__('base_path', BASE);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields("", []);
        delete_rewire.delete(DELETE_OBJECT, function(err, results) {
            assert.ok(err.message.length > 0);
            search_stub.restore();
            search_stub = sinon.stub(search, "searchByHash").yields("", [SEARCH_RESULT_OBJECT]);
            done();
        });
    });
});

describe('Test conditionalDelete', function () {
    //TODO: We dont currently use conditionalDelete so I'm not writing unit tests for it.  If we start using it, we need
//to add tests.
});

describe('Test deleteRecords', function () {
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
    it('Nominal path for delete Record', function (done) {
        delete_rewire.__set__('base_path', BASE);
        delete_rewire.deleteRecords(TEST_SCHEMA, TEST_TABLE_1, [SEARCH_RESULT_OBJECT], function(err) {
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
    it('deleteRecords with invalid schema', function (done) {
        delete_rewire.__set__('base_path', BASE);
        delete_rewire.deleteRecords(null, TEST_TABLE_1, [SEARCH_RESULT_OBJECT], function(err) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('deleteRecords with invalid table', function (done) {
        delete_rewire.__set__('base_path', BASE);
        delete_rewire.deleteRecords(TEST_SCHEMA, null, [SEARCH_RESULT_OBJECT], function(err) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('deleteRecords with empty records', function (done) {
        delete_rewire.__set__('base_path', BASE);
        delete_rewire.deleteRecords(TEST_SCHEMA, TEST_TABLE_1, [], function(err) {
            assert.ok(err.message.length > 0);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_HASH_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_INSTANCE_FILE_PATH), true);
            assert.equal(fs.existsSync(TABLE_1_ATTRIBUTE_2_HASH_FILE_PATH), true);
            done();
        });
    });
});
