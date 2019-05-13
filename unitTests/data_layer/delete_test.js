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
const util = require('util');

const ISO_8601_FORMAT = 'YYYY-MM-DD';
const ATTRIBUTE_1_INSTANCE_NAME = '';
const ATTRIBUTE_1_TIME_NAME = moment().valueOf();
const ATTRIBUTE_2_TIME_NAME = moment().subtract(6, 'hours').valueOf();
const TEST_FILE_NAME_1 = `${ATTRIBUTE_1_TIME_NAME}.hdb`;
const TEST_FILE_NAME_2 = `${ATTRIBUTE_2_TIME_NAME}.hdb`;
const FILE_CONTENTS = "Name";
const DELETE_MOD_BASE_PATH_NAME = 'BASE_PATH';
const TEST_ATTRIBUTE_NAME = 'Name';
const HASH_ATTRIBUTE_NAME = 'id';
const TEST_ATTRIBUTE_AGE = 'Age';

const TEST_DATA_DOG = [
    {
        "name":"Frank",
        "id":"1",
        "age":5,
        "table":"dog",
        "file_paths":[],
        "journal_paths":[]
    },
    {
        "name":"Bill",
        "id":"3",
        "age":4,
        "table":"dog",
        "file_paths":[],
        "journal_paths":[]
    }
];

const TEST_DATA_CAT = [
    {
        "name":"Eddie",
        "id":"2",
        "age":4,
        "table":"cat",
        "file_paths":[],
        "journal_paths":[]
    }
];

// const test_data_new = [
//     {
//         "name":"Frank",
//         "id":"1",
//         "age":5,
//         "file_paths":[],
//         "journal_paths":[]
//     },
//     {
//         "name":"Bill",
//         "id":"3",
//         "age":4,
//         "file_paths":[],
//         "journal_paths":[]
//     },
//     {
//         "name":"Eddie",
//         "id":"2",
//         "age":4,
//         "file_paths":[],
//         "journal_paths":[]
//     }
// ];

const BASE = process.cwd();
const BAD_DIR_PATH = '/tmp/zaphodbeeblebrox';
const HDB_HASH_FOLDER_NAME = '__hdb_hash';
const TEST_SCHEMA = 'test';
const TEST_SCHEMA_PATH = path.join(BASE, TEST_SCHEMA);
const TEST_TABLE_DOG = 'dog';
const TEST_TABLE_CAT = 'cat';
const TEST_TABLE_BIRD = 'bird';
const TEST_TABLE_DOG_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_DOG);
const TEST_TABLE_DOG_HASH_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_DOG, HDB_HASH_FOLDER_NAME);

const TABLE_DOG_ATTRIBUTE_PATH = path.join(TEST_TABLE_DOG_PATH, TEST_ATTRIBUTE_NAME);
const TABLE_DOG_ATTRIBUTE_HASH_DIRECTORY_PATH = path.join(TEST_TABLE_DOG_HASH_PATH, TEST_ATTRIBUTE_NAME);
const TABLE_DOG_ATTRIBUTE_INSTANCE_DIRECTORY_PATH = path.join(TABLE_DOG_ATTRIBUTE_PATH, ATTRIBUTE_1_INSTANCE_NAME);
const TABLE_DOG_ATTRIBUTE_HASH_FILE_PATH = path.join(TABLE_DOG_ATTRIBUTE_HASH_DIRECTORY_PATH, `${ATTRIBUTE_1_INSTANCE_NAME}.hdb`);
const TABLE_DOG_ATTRIBUTE_INSTANCE_FILE_PATH = path.join(TABLE_DOG_ATTRIBUTE_INSTANCE_DIRECTORY_PATH, TEST_FILE_NAME_1);
const TEST_TABLE_BIRD_PATH = path.join(TEST_SCHEMA_PATH, TEST_TABLE_BIRD);
const TABLE_HASH_ATTRIBUTE = 'id';
const TOMORROW_TIME = moment().add(1, 'days');
const YESTERDAY_TIME = moment().subtract(1, 'days');
const NOW = moment();

const TIMEOUT_VALUE_MS = 1000;

const SEARCH_RESULT_OBJECT = {};
SEARCH_RESULT_OBJECT[TEST_ATTRIBUTE_NAME] = ATTRIBUTE_1_INSTANCE_NAME;
let search_stub = sinon.stub(search, "searchByHash").yields("", [SEARCH_RESULT_OBJECT]);

let now_formatted = NOW.format(ISO_8601_FORMAT);
const TEST_DELETE_BEFORE_REQUEST = {
    "operation": "delete_files_before",
    "date": `${now_formatted}`,
    "schema": `${TEST_SCHEMA}`,
    "table": `${TEST_TABLE_DOG}`,
    "hdb_user": {},
    "hdb_auth_header": "Basic abcdefg"
};

// const test_table1 = test_utils.createMockSchemaTableFileStructure(BASE,'test', 'mog', test_data_new)
// const test_table2 = test_utils.createMockSchemaTableFileStructure(BASE,'test', 'vlog', test_data_new)
//
// global.hdb_schema = {
//     "test": {
//         "dog": {
//             "hash_attribute": `${HASH_ATTRIBUTE_NAME}`,
//             "id": "8650f230-be55-4455-8843-55bcfe7f61c4",
//             "name": "dog",
//             "schema": "test",
//             "attributes": [
//                 {
//                     "attribute": `${TEST_ATTRIBUTE_NAME}`
//                 },
//                 {
//                     "attribute": `${TEST_ATTRIBUTE_AGE}`
//                 }
//             ]
//         },
//         "cat": {
//             "hash_attribute": `${HASH_ATTRIBUTE_NAME}`,
//             "id": "8650f230-be55-4455-8843-55bcfe7f61c4",
//             "name": "cat",
//             "schema": "test",
//             "attributes": [
//                 {
//                     "attribute": `${TEST_ATTRIBUTE_NAME}`
//                 },
//                 {
//                     "attribute": `${TEST_ATTRIBUTE_AGE}`
//                 }
//             ]
//         },
//         "bird": {
//             "hash_attribute": `${HASH_ATTRIBUTE_NAME}`,
//             "id": "8650f230-be55-4455-8843-55bcfe7f61c4",
//             "name": "bird",
//             "schema": "test",
//             "attributes": [
//                 {
//                     "attribute": `${TEST_ATTRIBUTE_NAME}`
//                 },
//                 {
//                     "attribute": `${TEST_ATTRIBUTE_AGE}`
//                 }
//             ]
//         }
//     },
//     "system": {
//         "hdb_table": {
//             "hash_attribute": "id",
//             "name": "hdb_table",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ],
//             "attributes": [
//                 {
//                     "attribute": "id"
//                 },
//                 {
//                     "attribute": "name"
//                 },
//                 {
//                     "attribute": "hash_attribute"
//                 },
//                 {
//                     "attribute": "schema"
//                 }
//             ]
//         },
//         "hdb_drop_schema": {
//             "hash_attribute": "id",
//             "name": "hdb_drop_schema",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ]
//         },
//         "hdb_attribute": {
//             "hash_attribute": "id",
//             "name": "hdb_attribute",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ]
//         },
//         "hdb_schema": {
//             "hash_attribute": "name",
//             "name": "hdb_schema",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ],
//             "attributes": [
//                 {
//                     "attribute": "name"
//                 },
//                 {
//                     "attribute": "createddate"
//                 }
//             ]
//         },
//         "hdb_user": {
//             "hash_attribute": "username",
//             "name": "hdb_user",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ]
//         },
//         "hdb_role": {
//             "hash_attribute": "id",
//             "name": "hdb_user",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ]
//         },
//         "hdb_license": {
//             "hash_attribute": "license_key",
//             "name": "hdb_license",
//             "schema": "system"
//         },
//         "hdb_nodes": {
//             "hash_attribute": "name",
//             "residence": [
//                 "*"
//             ]
//         },
//         "hdb_queue": {
//             "hash_attribute": "id",
//             "name": "hdb_queue",
//             "schema": "system",
//             "residence": [
//                 "*"
//             ]
//         }
//     }
// }

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

// Promisified functions
const p_set_timeout = util.promisify(setTimeout);

/**
 * This function will simulate the HDB data structure with the data passed in.  It will pull the hash attribute from the
 * global.hdb_schema values above.  A table value must be defined in the data so the function knows which table to pull
 * from.  The schema is always assumed to be 'test'.
 * @param data
 */
// function fakeInsert(data) {
//     try {
//         let table = data.table;
//         let table_path = path.join(TEST_SCHEMA_PATH, table);
//         makeTheDir(table_path);
//         let table_hash_dir_path = path.join(table_path, HDB_HASH_FOLDER_NAME);
//         makeTheDir(table_hash_dir_path);
//         let hash_att = global.hdb_schema[TEST_SCHEMA][table].hash_attribute;
//         let keys = Object.keys(data).filter(word => (word !== 'table' && word !== 'file_paths' && word !== 'journal_paths'));
//
//         for(let i = 0; i<keys.length; i++) {
//             let curr_attribute = keys[i];
//             let is_hash = curr_attribute === hash_att;
//             let hash_dir_path = path.join(table_path, HDB_HASH_FOLDER_NAME, curr_attribute);
//             makeTheDir(hash_dir_path);
//             let attribute_dir_path = path.join(table_path, curr_attribute);
//             makeTheDir(attribute_dir_path);
//             let attribute_instance_dir_path = path.join(attribute_dir_path, `${data[curr_attribute]}`);
//             makeTheDir(attribute_instance_dir_path);
//             if(is_hash) {
//                 data.journal_paths.push(attribute_instance_dir_path);
//             }
//             // make the hash file
//             let hash_file_path = path.join(hash_dir_path, data[hash_att] + '.hdb');
//             fs.writeFileSync(hash_file_path, data[curr_attribute]);
//             data.file_paths.push(hash_file_path);
//             if(!is_hash) {
//                 let link_path = path.join(attribute_instance_dir_path, data[hash_att] + '.hdb');
//                 fs.linkSync(hash_file_path, link_path);
//                 data.file_paths.push(link_path);
//             } else {
//                 // for hash attributes, we need to write a file with the current time stamp and the delta of the data
//                 let time_file_name = path.join(attribute_instance_dir_path, `${moment().valueOf()}.hdb`);
//                 fs.writeFileSync(time_file_name, util.inspect(data), 'utf-8');
//                 data.journal_paths.push(time_file_name);
//                 data.file_paths.push(time_file_name);
//             }
//         }
//     } catch(e) {
//         console.error(e);
//     }
// }

function setup() {
    // makeTheDir(TEST_SCHEMA_PATH);
    const test_data_clone_dog = test_utils.deepClone(TEST_DATA_DOG);
    const test_data_clone_cat = test_utils.deepClone(TEST_DATA_CAT);

    const dog_instance = test_utils.createMockSchemaTableFileStructure(TEST_SCHEMA_PATH, TEST_SCHEMA, TEST_TABLE_DOG, test_data_clone_dog);
    const cat_instance = test_utils.createMockSchemaTableFileStructure(TEST_SCHEMA_PATH, TEST_SCHEMA, TEST_TABLE_CAT, test_data_clone_cat);
    //Setup empty table 3
    test_utils.makeTheDir(TEST_TABLE_BIRD_PATH);
    test_utils.makeTheDir(path.join(TEST_TABLE_BIRD_PATH, TABLE_HASH_ATTRIBUTE));

    // Writes a text file to ensure listDirectories only shows directories
    // TODO: Ask ELi what this means.
    fs.writeFileSync(path.join(TEST_SCHEMA_PATH, TEST_FILE_NAME_2), FILE_CONTENTS);
    return {
        [TEST_TABLE_DOG]: dog_instance,
        [TEST_TABLE_CAT]: cat_instance
    };
}

function tearDown(target_path) {
    if(!target_path) return;
    let files = [];
    if( fs.existsSync(target_path) ) {
        try {
            files = fs.readdirSync(target_path);
            for(let i = 0; i<files.length; i++) {
                let file = files[i];
                let curPath = path.join(target_path, file);
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    tearDown(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            }
            fs.rmdirSync(target_path);
        } catch (e) {
            console.error(e);
        }
    }
    search_stub.restore();
};


describe('Test deleteFilesBefore', function () {
    let delete_search_result = [];
    let test_data_instance = undefined;

    beforeEach(function () {
        try {
            delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
            test_data_instance = undefined;
            test_data_instance = setup();
        } catch (e) {
            console.error(e);
        }
    });
    afterEach(function () {
        try {
            tearDown(TEST_SCHEMA_PATH);
            search_stub.restore();
            delete_search_result = [];
        } catch (e) {
            console.error(e);
        }
    });
    it('deleteFilesBefore with yesterday as a time stamp, expect no files removed', async function () {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = YESTERDAY_TIME.format(ISO_8601_FORMAT);
        delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        try {
            await delete_rewire.deleteFilesBefore(request);
            let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths];
            for(let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
            }
        } catch(e) {
            throw e;
        }
    });
    it('Nominal path of deleteFilesBefore with 1 directory', async function () {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.table = TEST_TABLE_CAT;
        request.date = TOMORROW_TIME.format(ISO_8601_FORMAT);
        delete_search_result = [];
        delete_search_result.push(TEST_DATA_CAT[0]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        try {
            await delete_rewire.deleteFilesBefore(request);
            let files_to_check =[...test_data_instance[TEST_TABLE_CAT][0].file_paths];
            for(let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), false, `FAILURE: file ${files_to_check[i]} exists but shouldnt.`);
            }
        } catch(e) {
            throw e;
        }
    });
    it('Nominal path of deleteFilesBefore on the dog table', async function () {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = TOMORROW_TIME.format(ISO_8601_FORMAT);
        delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);

        try {
            await delete_rewire.deleteFilesBefore(request);
            let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
            for(let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), false, `FAILURE: file ${files_to_check[i]} exists but shouldnt.`);
            }
        } catch(e) {
            throw e;
        }
    });
    it('Call deleteFilesBefore with null date', async function () {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = null;
        let err = undefined;
        try {
            await delete_rewire.deleteFilesBefore(request);
        } catch(e) {
            err = e;
        }
        assert.equal(err.message, 'Invalid date.');
    });

    it(`Call deleteFileBefore with null schema`, async function() {
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.schema = null;
        let err = undefined;
        try {
            await delete_rewire.deleteFilesBefore(request);
        } catch(e) {
            err = e;
        }
        assert.equal(err.message, "Invalid schema.");
    });

    it(`Call deleteFileBefore with null table`, async function() {
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.table = null;
        let err = undefined;
        try {
            await delete_rewire.deleteFilesBefore(request);
        } catch(e) {
            err = e;
        }
        assert.equal(err.message, "Invalid table.");
    });

    it('Call deleteFilesBefore with valid date strings, nothing removed', async function() {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '2011-01-11';
        delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);

        try {
            await delete_rewire.deleteFilesBefore(request);
            let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
            for(let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} was deleted.`);
            }
        } catch(e) {
            throw e;
        }
    });
    // Test date with Times included
    it('Call with valid date/time, nothing removed', async function() {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '2011-01-11T17:45:55+00:00';
        delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);

        try {
            await delete_rewire.deleteFilesBefore(request);
            let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
            for(let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} was deleted.`);
            }
        } catch(e) {
            throw e;
        }
    });
    // Test leap year silliness
    it('Call with invalid leap year', async function() {
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '2011-02-29';

        let err = undefined;
        try {
            await delete_rewire.deleteFilesBefore(request);
        } catch(e) {
            err = e;
        }
        assert.equal(err.message, 'Invalid date, must be in ISO-8601 format (YYYY-MM-DD).');
    });
    //Test Epoc
    it('Call with Epoc', async function() {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let request = test_utils.deepClone(TEST_DELETE_BEFORE_REQUEST);
        request.date = '1969-01-01';
        delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);

        try {
            await delete_rewire.deleteFilesBefore(request);
            let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
            for(let i = 0; i < files_to_check.length; i++) {
                assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} exists but shouldnt.`);
            }
        } catch(e) {
            throw e;
        }
    });
});

describe('Test deleteFilesInPath', function () {
    let test_data_instance = undefined;
    let deleteFilesInPath = delete_rewire.__get__('deleteFilesInPath');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);

    beforeEach( function() {
        try {
            test_data_instance = undefined;
            test_data_instance = setup();
        } catch(e) {
            console.error(e);
        }
    });
    afterEach( function() {
        try {
            tearDown(TEST_SCHEMA_PATH);
            search_stub.restore();
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path of deleteFilesInPath, test against DOG table', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await deleteFilesInPath(TEST_SCHEMA, TEST_TABLE_DOG, TEST_TABLE_DOG_PATH, TOMORROW_TIME)
            .catch(e => {
                console.error(e);
                done(e);
            });
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < files_to_check.length; i++) {
            assert.equal(fs.existsSync(files_to_check[i]), false, `FAILURE: file ${files_to_check[i]} still exists.`);
        }
    }));
    it('Test invalid directory parameter.  Expect no files to be deleted.', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await deleteFilesInPath(TEST_SCHEMA, TEST_TABLE_DOG, null, TOMORROW_TIME)
            .catch(e => {
                console.error(e);
                done(e);
            });
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < files_to_check.length; i++) {
            assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
        }
    }));
    it('Test invalid date parameter.  Expect no files to be deleted.', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await deleteFilesInPath(TEST_SCHEMA, TEST_TABLE_DOG, TEST_TABLE_DOG_PATH, "2011-01-01")
            .catch(e => {
                console.error(e);
                done(e);
            });
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < files_to_check.length; i++) {
            assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
        }
    }));
    it('Test invalid schema parameter.  Expect no files to be deleted.', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await deleteFilesInPath(null, TEST_TABLE_DOG, TEST_TABLE_DOG_PATH, TOMORROW_TIME)
            .catch(e => {
                console.error(e);
                done(e);
            });
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < files_to_check.length; i++) {
            assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
        }
    }));
    it('Test invalid table parameter.  Expect no files to be deleted.', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await deleteFilesInPath(TEST_SCHEMA, null, TEST_TABLE_DOG_PATH, TOMORROW_TIME)
            .catch(e => {
                console.error(e);
                done(e);
            });
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < files_to_check.length; i++) {
            assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
        }
    }));
    it('Test with table not found in the schema.  Expect no files to be deleted.', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0]);
        delete_search_result.push(TEST_DATA_DOG[1]);
        let files_to_check = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await deleteFilesInPath(TEST_SCHEMA, "Fish", TEST_TABLE_DOG_PATH, TOMORROW_TIME)
            .catch(e => {
                console.error(e);
                done(e);
            });
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < files_to_check.length; i++) {
            assert.equal(fs.existsSync(files_to_check[i]), true, `FAILURE: file ${files_to_check[i]} does not exist.`);
        }
    }));
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
            search_stub.restore();
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path with directory that exists.', test_utils.mochaAsyncWrapper(async () => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let doesExist = await doesDirectoryExist(TEST_TABLE_DOG_PATH);
        assert.equal(doesExist, true);
    }));
    it('Test non existent directory', test_utils.mochaAsyncWrapper(async () => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let doesExist = await doesDirectoryExist(BAD_DIR_PATH);
        assert.equal(doesExist, false);
    }));
    it('Test null directory', test_utils.mochaAsyncWrapper(async () => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let doesExist = await doesDirectoryExist(null);
        assert.equal(doesExist, false);
    }));
});

describe('Test inspectHashAttributeDir', function() {
    let inspectHashAttributeDir = delete_rewire.__get__('inspectHashAttributeDir');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
    beforeEach( function(done) {
        try {
            setup();
            done();
        } catch(e) {
            console.log(e);
            done(e);
        }
    });
    afterEach( function(done) {
        try {
            tearDown(TEST_SCHEMA_PATH);
            search_stub.restore();
            done();
        } catch(e) {
            console.log(e);
            done(e);
        }
    });
    it('Nominal path to search the dog directory.  Should find both ids in TEST_DATA', test_utils.mochaAsyncWrapper(async () => {
        let found_hashes_to_remove = [];
        let hash_attribute_dir_path = path.join(TEST_SCHEMA, TEST_TABLE_DOG, TABLE_HASH_ATTRIBUTE);
        await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
        assert.equal(found_hashes_to_remove.length, 2);
    }));
    it('Nominal path to search the cat directory.  Should find 1 id TEST_DATA', test_utils.mochaAsyncWrapper(async () => {
        let found_hashes_to_remove = [];
        let hash_attribute_dir_path = path.join(TEST_SCHEMA, TEST_TABLE_CAT, TABLE_HASH_ATTRIBUTE);
        await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
        assert.equal(found_hashes_to_remove.length, 1);
    }));
    it('Nominal path to search the bird directory.  Should find 0 ids', test_utils.mochaAsyncWrapper(async () => {
        let found_hashes_to_remove = [];
        let hash_attribute_dir_path = path.join(TEST_SCHEMA, TEST_TABLE_BIRD, TABLE_HASH_ATTRIBUTE);
        await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
        assert.equal(found_hashes_to_remove.length, 0);
    }));
    it('Create a later time id file in CAT table simulating an update.  Should find 0 ids.', test_utils.mochaAsyncWrapper(async () => {
        let found_hashes_to_remove = [];
        let hash_attribute_dir_path = path.join(BASE, TEST_SCHEMA, TEST_TABLE_CAT, TABLE_HASH_ATTRIBUTE);
        try {
            let new_file_path = path.join(hash_attribute_dir_path, TEST_DATA_CAT[0].id, TOMORROW_TIME.valueOf().toString() + '.hdb');
            fs.writeFileSync(new_file_path, "blah blah");
        } catch(e) {
            console.error(e);
        }
        await inspectHashAttributeDir(NOW.add(1, "hours").valueOf(), hash_attribute_dir_path, found_hashes_to_remove);
        assert.equal(found_hashes_to_remove.length, 0);
    }));
    it('Pass invalid directory, should return 0 ids.', test_utils.mochaAsyncWrapper(async () => {
        let found_hashes_to_remove = [];
        await inspectHashAttributeDir(TOMORROW_TIME.valueOf(), BAD_DIR_PATH, found_hashes_to_remove);
        assert.equal(found_hashes_to_remove.length, 0);
    }));
    it('Pass invalid date, should return 0 ids.', test_utils.mochaAsyncWrapper(async () => {
        let found_hashes_to_remove = [];
        await inspectHashAttributeDir(0, TEST_TABLE_DOG, found_hashes_to_remove);
        assert.equal(found_hashes_to_remove.length, 0);
    }));
});

describe('Test isFileTimeBeforeParameterTime', function() {
    let isFileTimeBeforeParameterTime = delete_rewire.__get__('isFileTimeBeforeParameterTime');
    it('Nominal path of isFileTimeBeforeParameterTime, tomorrow is greater than now expect true', function() {
        let now = moment();
        let tomorrow = moment().add(1, "days").valueOf();
        let now_file_name = now.valueOf().toString() + '.hdb';
        let result = isFileTimeBeforeParameterTime(tomorrow, now_file_name);
        assert.equal(result, true);
    });
    it('Nominal path of isFileTimeBeforeParameterTime, yesterday is less than now expect false', function() {
        let now = moment();
        let yesterday = moment().subtract(1, "days").valueOf();
        let now_file_name = now.valueOf().toString() + '.hdb';
        let result = isFileTimeBeforeParameterTime(yesterday, now_file_name);
        assert.equal(result, false);
    });
    it('test isFileTimeBeforeParameterTime close times', function() {
        let now = moment();
        let now_plus_ms = moment(now).add(1, "ms").valueOf();
        let now_file_name = now.valueOf().toString() + '.hdb';
        let result = isFileTimeBeforeParameterTime(now_plus_ms, now_file_name);
        assert.equal(result, true);
    });
    it('test isFileTimeBeforeParameterTime with date passed as string', function() {
        let now = moment();
        let tomorrow = moment().add(1, "days").valueOf();
        let now_file_name = now.valueOf().toString() + '.hdb';
        let result = isFileTimeBeforeParameterTime(tomorrow.toString(), now_file_name);
        assert.equal(result, false);
    });
    it('test isFileTimeBeforeParameterTime with date passed as null', function() {
        let now = moment();
        let now_file_name = now.valueOf().toString() + '.hdb';
        let result = isFileTimeBeforeParameterTime(null, now_file_name);
        assert.equal(result, false);
    });
    it('test isFileTimeBeforeParameterTime with file passed as null', function() {
        let tomorrow = moment().add(1, "days").valueOf();
        let result = isFileTimeBeforeParameterTime(tomorrow, null);
        assert.equal(result, false);
    });
    it('test isFileTimeBeforeParameterTime with file passed as empty string' , function() {
        let tomorrow = moment().add(1, "days").valueOf();
        let result = isFileTimeBeforeParameterTime(tomorrow, "");
        assert.equal(result, false);
    });
});

describe('Test removeFiles', function() {
    let removeFiles = delete_rewire.__get__('removeFiles');
    let files_to_remove = [];
    let test_data_instance = null;
    beforeEach( function(done) {
        try {
            test_data_instance = setup();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    afterEach( function(done) {
        try {
            tearDown(TEST_SCHEMA_PATH);
            files_to_remove = [];
            search_stub.restore();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    it('Nominal path of removeFiles on dog table', test_utils.mochaAsyncWrapper(async () => {
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0], TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        let entry_1_id_path = test_data_instance[TEST_TABLE_DOG][0].id;
        let entry_2_id_path = test_data_instance[TEST_TABLE_DOG][1].id;
        let id_files_to_remove = [];
        id_files_to_remove.push(entry_1_id_path);
        id_files_to_remove.push(entry_2_id_path);
        files_to_remove = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        await removeFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE_NAME, id_files_to_remove);
        for( let file of files_to_remove) {
            assert.equal(fs.existsSync(file), false, `File ${file} still exists.`);
        }
    }));
    it('removeFiles with empty files parameter', test_utils.mochaAsyncWrapper(async () => {
        let files_to_remove = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0], TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, delete_search_result);
        await removeFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE_NAME, []);
        for( let file of files_to_remove) {
            assert.equal(fs.existsSync(file), true, `File ${file} still exists.`);
        }
    }));
    it('removeFiles with all invalid files parameter', test_utils.mochaAsyncWrapper(async () => {
        let files_to_remove = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0], TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, []);
        let bad_files = [BAD_DIR_PATH]
        await removeFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE_NAME, bad_files);
        for( let file of files_to_remove) {
            assert.equal(fs.existsSync(file), true, `File ${file} still exists.`);
        }
    }));
    it('removeFiles with null files parameter', test_utils.mochaAsyncWrapper(async () => {
        let files_to_remove = [...test_data_instance[TEST_TABLE_DOG][0].file_paths, ...test_data_instance[TEST_TABLE_DOG][1].file_paths];
        let delete_search_result = [];
        delete_search_result.push(TEST_DATA_DOG[0], TEST_DATA_DOG[1]);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields(null, []);
        let bad_files = [BAD_DIR_PATH]
        await removeFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE_NAME, null);
        for( let file of files_to_remove) {
            assert.equal(fs.existsSync(file), true, `File ${file} still exists.`);
        }
    }));
});

describe('Test removeIDFiles', function() {
    let removeIDFiles = delete_rewire.__get__('removeIDFiles');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
    let test_values = undefined;
    beforeEach(() => {
        try {
            test_values = setup();
        } catch(e) {
            console.error(e);
        }
    });
    afterEach(() => {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch(e) {
            console.error(e);
        }
    });
    it('Nominal path of removeIDFiles against dog table.', test_utils.mochaAsyncWrapper(async (done) => {
        let journal_files = [...test_values[TEST_TABLE_DOG][0].journal_paths, ...test_values[TEST_TABLE_DOG][1].journal_paths];
        let ids = test_values[TEST_TABLE_DOG].map(a => a.id);
        await removeIDFiles(TEST_SCHEMA, TEST_TABLE_DOG, HASH_ATTRIBUTE_NAME, ids);
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < journal_files.length; i++) {
            assert.equal(fs.existsSync(journal_files[i]), false, `FAILURE: file ${journal_files[i]} still exists.`);
        }

    }));
    it('Try to pass system schema.', test_utils.mochaAsyncWrapper(async (done) => {
        let journal_files = [...test_values[TEST_TABLE_DOG][0].journal_paths, ...test_values[TEST_TABLE_DOG][1].journal_paths];
        await removeIDFiles('system', TEST_TABLE_DOG, journal_files);
        await p_set_timeout(TIMEOUT_VALUE_MS)
            .catch(e => {
                console.error(e);
                done(e);
            });
        for(let i = 0; i < journal_files.length; i++) {
            assert.equal(fs.existsSync(journal_files[i]), true, `FAILURE: file ${journal_files[i]} does not exist.`);
        }
    }));
});

describe('Test getDirectoriesInPath', () => {
    let getDirectoriesInPath = delete_rewire.__get__('getDirectoriesInPath');
    delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
    before(() => {
        try {
            setup();
        } catch(e) {
            console.error(e);
        }
    });
    after(() => {
        try {
            tearDown(TEST_SCHEMA_PATH);
        } catch(e) {
            console.error(e);
        }
    });
    // There should be 2 directories, each with 1 file, and 1 text file in the current directory
    it('Nominal path of getDirectoriesInPath', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = [];
        await getDirectoriesInPath(TEST_TABLE_DOG_PATH, list_dir_results, TOMORROW_TIME);
        assert.equal(Object.keys(list_dir_results).length, 9);
    }));

    it('test getDirectoriesInPath with a null path', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = [];
        await getDirectoriesInPath(null, list_dir_results, TOMORROW_TIME);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));

    it('test getDirectoriesInPath with a space as path', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = [];
        await getDirectoriesInPath(' ', list_dir_results, TOMORROW_TIME);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));

    it('test getDirectoriesInPath with an invalid path', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = [];
        await getDirectoriesInPath('../askdsdfsadc', list_dir_results, TOMORROW_TIME);
        assert.equal(Object.keys(list_dir_results).length, 0);
    }));

    it('test getDirectoriesInPath with 1 directory found', test_utils.mochaAsyncWrapper(async () => {
        let list_dir_results = [];
        await getDirectoriesInPath(TEST_TABLE_BIRD_PATH, list_dir_results, TOMORROW_TIME);
        assert.equal(Object.keys(list_dir_results).length, 1);
    }));
});

describe('Test deleteRecord', () => {
    let global_schema_stub = sinon.stub(global_schema, "getTableSchema").yields("", null);

    beforeEach((done) => {
        try {
            search_stub.restore();
            search_stub = sinon.stub(search, "searchByHash").yields("", [SEARCH_RESULT_OBJECT]);
            setup();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    afterEach((done) => {
        try {
            tearDown(TEST_SCHEMA_PATH);
            search_stub.restore();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    it('Nominal path for delete Record', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.delete(DELETE_OBJECT, (err, results) => {
            assert.equal(fs.existsSync(TABLE_DOG_ATTRIBUTE_HASH_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_DOG_ATTRIBUTE_INSTANCE_FILE_PATH), false);
            done();
        });
    });
    it('test deleteRecord with bad deleteObject parameter', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.delete(null, (err, results) => {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('test deleteRecord with bad schema in deleteObject parameter', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let del_obj = test_utils.deepClone(DELETE_OBJECT);
        del_obj.schema = 'hootiehoo';
        delete_rewire.delete(del_obj, (err, results) => {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('test deleteRecord with bad table in deleteObject parameter', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        let del_obj = test_utils.deepClone(DELETE_OBJECT);
        del_obj.table = 'hootiehoo';
        delete_rewire.delete(del_obj, (err, results) => {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('test deleteRecord with search returning no results', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        search_stub.restore();
        search_stub = sinon.stub(search, "searchByHash").yields("", []);
        delete_rewire.delete(DELETE_OBJECT, (err, results) => {
            assert.ok(err.message.length > 0);
            search_stub.restore();
            search_stub = sinon.stub(search, "searchByHash").yields("", [SEARCH_RESULT_OBJECT]);
            done();
        });
    });
});

describe('Test conditionalDelete', () => {
    //TODO: We dont currently use conditionalDelete so I'm not writing unit tests for it.  If we start using it, we need
//to add tests.
});

describe('Test deleteRecords', () => {
    beforeEach((done) => {
        try {
            setup();
            done();
        } catch(e) {
            console.log(e);
        }
    });
    afterEach((done) => {
        try {
            tearDown(TEST_SCHEMA_PATH);
            done();
        } catch(e) {
            console.log(e);
        }
    });
    it('Nominal path for delete Record', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteRecords(TEST_SCHEMA, TEST_TABLE_DOG, [SEARCH_RESULT_OBJECT], (err) => {
            assert.equal(fs.existsSync(TABLE_DOG_ATTRIBUTE_HASH_FILE_PATH), false);
            assert.equal(fs.existsSync(TABLE_DOG_ATTRIBUTE_INSTANCE_FILE_PATH), false);
            done();
        });
    });
    it('deleteRecords with invalid schema', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteRecords(null, TEST_TABLE_DOG, [SEARCH_RESULT_OBJECT], function(err) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('deleteRecords with invalid table', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteRecords(TEST_SCHEMA, null, [SEARCH_RESULT_OBJECT], function(err) {
            assert.ok(err.message.length > 0);
            done();
        });
    });
    it('deleteRecords with empty records', (done) => {
        delete_rewire.__set__(DELETE_MOD_BASE_PATH_NAME, BASE);
        delete_rewire.deleteRecords(TEST_SCHEMA, TEST_TABLE_DOG, [], function(err) {
            assert.ok(err.message.length > 0);

            done();
        });
    });
});
