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
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');
const root_original = env_mgr.get('HDB_ROOT');
env_mgr.setProperty('HDB_ROOT', BASE_PATH);
let test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const lmdb_drop_attribute = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbDropAllAttributes');
const search_by_value = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByValue');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_create_records = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const LMDB_ERRORS = require('../../../../commonTestErrors').LMDB_ERRORS_ENUM;
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const CREATE_SCHEMA_DEV = {
    operation: 'create_schema',
    schema: 'dev'
};

const CREATE_TABLE_OBJ_TEST_A = {
    operation: 'create_table',
    schema: 'dev',
    table: 'test',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_A = {
    name: CREATE_TABLE_OBJ_TEST_A.table,
    schema: CREATE_TABLE_OBJ_TEST_A.schema,
    id: '82j3r4',
    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
    residence: '*'
};

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: 'dev',
    table: 'test',
    records: test_data
};

describe('test lmdbDropAllAttributes module', ()=>{
    let date_stub;
    let rw_env_util;
    before(async ()=>{
        await fs.remove(BASE_PATH);
        rw_env_util = environment_utility.__set__('MAP_SIZE', 5*1024*1024*1024);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        env_mgr.setProperty('HDB_ROOT', BASE_PATH);
    });

    after(()=>{
        rw_env_util();
        date_stub.restore();
        env_mgr.setProperty('HDB_ROOT', root_original);
    });

    describe('test lmdbDropAllAttributes function', ()=>{
        before(async () => {
            await fs.mkdirp(SYSTEM_SCHEMA_PATH);
            await fs.mkdirp(DEV_SCHEMA_PATH);
            global.lmdb_map = undefined;

            global.hdb_schema = {
                dev: {
                    test: {
                        attributes: [],
                        hash_attribute: 'id',
                        schema: 'dev',
                        name: 'test'
                    }
                },
                system: systemSchema};

            let hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

            let hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

            let hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
            global.hdb_schema.dev.test.attributes = [
                {attribute:'id'},
                {attribute:'__updatedtime__'},
                {attribute:'__createdtime__'},
            ];

            await lmdb_create_records(INSERT_OBJECT_TEST);

            global.hdb_schema.dev.test.attributes = [
                {attribute:'id'},
                {attribute:'temperature'},
                {attribute:'temperature_double'},
                {attribute:'temperature_pos'},
                {attribute:'temperature_neg'},
                {attribute:'temperature_str'},
                {attribute:'city'},
                {attribute:'state'},
                {attribute:'__updatedtime__'},
                {attribute:'__createdtime__'},
            ];
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('Test invalid schema', async ()=>{
            let drop_obj = {
                schema: "blerg",
                table: "test"
            };
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_obj],
                new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('Test invalid table', async ()=>{
            let drop_obj = {
                schema: "dev",
                table: "fake"
            };
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_obj],
                new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('test removing all attributes', async()=>{
            let search_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['*']);
            let results = await test_utils.assertErrorAsync(search_by_value, [search_obj], undefined);
            assert.notDeepStrictEqual(results.length, 0);

            let drop_obj = {
                schema: "dev",
                table: "test"
            };
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_obj], undefined);
            let new_results = await test_utils.assertErrorAsync(search_by_value, [search_obj], undefined);
            assert.deepStrictEqual(new_results.length, 0);

            let env = await test_utils.assertErrorAsync(environment_utility.openEnvironment, [DEV_SCHEMA_PATH, 'test'], undefined);
            let dbis = await test_utils.assertErrorAsync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(dbis.length, 0);

            for(let x = 0; x < results.length; x++){
                await test_utils.assertErrorAsync(environment_utility.openDBI, [env, results[x].attribute], LMDB_ERRORS.DBI_DOES_NOT_EXIST);
            }
        });
    });

});