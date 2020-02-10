'use strict';

const path = require('path');
const env_mgr = require('../../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}
const test_utils = require('../../../../test_utils');
const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const root_original = env_mgr.get('HDB_ROOT');
env_mgr.setProperty('HDB_ROOT', BASE_PATH);

const rewire = require('rewire');
const lmdb_create_records = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const lmdb_get_data_by_hash = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbGetDataByHash');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const SearchByHashObject = require('../../../../../data_layer/SearchByHashObject');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

const TIMESTAMP = Date.now();
const HASH_ATTRIBUTE_NAME = 'id';

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: 'dev',
    table: 'dog',
    records: [
        {
            name: "Harper",
            breed: "Mutt",
            id: "8",
            age: 5
        },
        {
            name: "Penny",
            breed: "Mutt",
            id: "9",
            age: 5,
            height: 145
        },
        {
            name: "David",
            breed: "Mutt",
            id: "12"
        },
        {
            name: "Rob",
            breed: "Mutt",
            id: "10",
            age: 5,
            height: 145
        }
    ]
};

const ALL_FETCH_ATTRIBUTES = ['__createdtime__', '__updatedtime__', 'age', 'breed', 'height', 'id', 'name'];

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: 'dog',
    hash_attribute: HASH_ATTRIBUTE_NAME,
    schema: 'dev',
    attributes: []
};

const CREATE_SCHEMA_DEV = {
    operation: 'create_schema',
    schema: 'dev'
};

const CREATE_TABLE_OBJ_TEST_A = {
    operation: 'create_table',
    schema: 'dev',
    table: 'dog',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_A = {
    name: CREATE_TABLE_OBJ_TEST_A.table,
    schema: CREATE_TABLE_OBJ_TEST_A.schema,
    id: '82j3r4',
    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
    residence: '*'
};

const sandbox = sinon.createSandbox();

describe('Test lmdbGetDataByHash module', ()=>{
    let date_stub;
    let hdb_schema_env;
    let hdb_table_env;
    let hdb_attribute_env;
    let rw_env_util;
    before(()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        env_mgr.setProperty('HDB_ROOT', BASE_PATH);
    });

    after(()=>{
        rw_env_util();
        date_stub.restore();
        env_mgr.setProperty('HDB_ROOT', root_original);
    });

    describe('Test lmdbGetDataByHash function', ()=>{

        beforeEach(async ()=>{
            global.hdb_schema = {
                [SCHEMA_TABLE_TEST.schema]: {
                    [SCHEMA_TABLE_TEST.name]: {
                        attributes: ALL_FETCH_ATTRIBUTES,
                        hash_attribute: SCHEMA_TABLE_TEST.hash_attribute,
                        residence: SCHEMA_TABLE_TEST.residence,
                        schema: SCHEMA_TABLE_TEST.schema,
                        name: SCHEMA_TABLE_TEST.name
                    }
                },
                system: systemSchema};

            await fs.mkdirp(SYSTEM_SCHEMA_PATH);

            global.lmdb_map = undefined;

            hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

            hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

            hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);

            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
            await lmdb_create_records(insert_obj);
        });

        afterEach(async ()=>{
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
            delete global.hdb_schema;
        });

        it('test validation', async()=>{
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [{}],
                new Error("Schema can't be blank,Table can't be blank,Hash values can't be blank,Get attributes can't be blank"));

            let search_obj = new SearchByHashObject('dev');
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj],
                new Error("Table can't be blank,Hash values can't be blank,Get attributes can't be blank"));

            search_obj = new SearchByHashObject('dev', 'dog');
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj],
                new Error("Hash values can't be blank,Get attributes can't be blank"));

            search_obj = new SearchByHashObject('dev', 'dog',[8]);
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj],
                new Error("Get attributes can't be blank"));

            search_obj = new SearchByHashObject('dev', 'dog', [8], ALL_FETCH_ATTRIBUTES);
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], undefined);

            search_obj = new SearchByHashObject('dev', 'dog', 8, ALL_FETCH_ATTRIBUTES);
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], new Error('hash_values must be an array'));

            search_obj = new SearchByHashObject('dev', 'dog', [8], 'test');
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], new Error('get_attributes must be an array'));

            search_obj = new SearchByHashObject('dev', 'dog', [], ALL_FETCH_ATTRIBUTES);
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], new Error('Hash values can\'t be blank'));

            search_obj = new SearchByHashObject('dev', 'dog', [8], []);
            await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], new Error('Get attributes can\'t be blank'));
        });

        it('test finding 1 row', async()=>{
            let exp_obj = test_utils.deepClone(INSERT_OBJECT_TEST.records[0]);
            exp_obj.__updatedtime__ = TIMESTAMP;
            exp_obj.__createdtime__ = TIMESTAMP;
            exp_obj.height = undefined;
            let expected_result = test_utils.assignObjecttoNullObject({
              8:   test_utils.assignObjecttoNullObject(exp_obj)
            });

            let search_obj = new SearchByHashObject('dev', 'dog', [8], ALL_FETCH_ATTRIBUTES);
            let results = await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], undefined);

            assert.deepStrictEqual(results, expected_result);
        });

        it('test finding 1 row some attributes', async()=>{
            let expected_result = test_utils.assignObjecttoNullObject({
                8:   test_utils.assignObjecttoNullObject({name: 'Harper'})
            });

            let search_obj = new SearchByHashObject('dev', 'dog', [8], ['name']);
            let results = await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], undefined);

            assert.deepStrictEqual(results, expected_result);
        });

        it('test finding multiple rows row, some attributes', async()=>{

            let expected_result = test_utils.assignObjecttoNullObject({
                8:   test_utils.assignObjecttoNullObject({id:'8', height:undefined}),
                10:   test_utils.assignObjecttoNullObject({id:'10', height:145})
            });

            let search_obj = new SearchByHashObject('dev', 'dog', [10, 8], ['id', 'height']);
            let results = await test_utils.assertErrorAsync(lmdb_get_data_by_hash, [search_obj], undefined);

            assert.deepStrictEqual(results, expected_result);
        });

    });


});