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
const DropAttributeObject = require('../../../../../data_layer/DropAttributeObject');
const lmdb_drop_schema = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbDropSchema');
const search_by_value = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByValue');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_create_records = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const validate_drop_schema = lmdb_drop_schema.__get__('validateDropSchema');

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

const CREATE_TABLE_OBJ_TEST_B = {
    operation: 'create_table',
    schema: 'dev',
    table: 'test2',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_B = {
    name: CREATE_TABLE_OBJ_TEST_B.table,
    schema: CREATE_TABLE_OBJ_TEST_B.schema,
    id: '82j3r478',
    hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute,
    residence: '*'
};

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: 'dev',
    table: 'test',
    records: test_data
};

const INSERT_OBJECT_TESTB = {
    operation: "insert",
    schema: 'dev',
    table: 'test2',
    records: test_data
};

describe('test validateDropSchema module', ()=>{
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

    describe('test methods', ()=>{
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
                    },
                    test2: {
                        attributes: [],
                        hash_attribute: 'id',
                        schema: 'dev',
                        name: 'test2'
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

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);
            global.hdb_schema.dev.test2.attributes = [
                {attribute:'id'},
                {attribute:'__updatedtime__'},
                {attribute:'__createdtime__'},
            ];

            await lmdb_create_records(INSERT_OBJECT_TESTB);

            global.hdb_schema.dev.test2.attributes = [
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

        it('test validate invalid schema', async()=>{
            await test_utils.assertErrorAsync(validate_drop_schema, ['faker'],
                new Error(`schema 'faker' does not exist`));
        });

        it('test validate happy path', async()=>{
            let result = await test_utils.assertErrorAsync(validate_drop_schema, ['dev'], undefined);
            assert.deepStrictEqual(result, 'dev');
        });

        it('test delete schema', async()=>{
            let search_obj = new SearchObject('system', 'hdb_table', 'schema', 'dev', undefined, ['schema', 'name']);
            let search_table_results = await search_by_value(search_obj);
            assert.deepEqual(search_table_results, [{schema:'dev', name:'test'}, {schema:'dev', name:'test2'}]);

            let search_attr_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['attribute']);
            let search_attr_results = await search_by_value(search_attr_obj);
            assert.deepStrictEqual(search_attr_results.length, global.hdb_schema.dev.test.attributes.length);

            for(let x = 0; x < search_attr_results.length; x++){
                let actual = search_attr_results[x];
                let expected;
                global.hdb_schema.dev.test.attributes.forEach(attr=>{
                    if(actual.attribute === attr.attribute){
                        expected = attr;
                    }

                });
                assert.deepEqual(actual, expected);
            }

            let search_attr_obj2 = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test2', undefined, ['attribute']);
            let search_attr_results2 = await search_by_value(search_attr_obj2);
            assert.deepStrictEqual(search_attr_results2.length, global.hdb_schema.dev.test2.attributes.length);

            for(let x = 0; x < search_attr_results2.length; x++){
                let actual = search_attr_results2[x];
                let expected;
                global.hdb_schema.dev.test2.attributes.forEach(attr=>{
                    if(actual.attribute === attr.attribute){
                        expected = attr;
                    }

                });
                assert.deepEqual(actual, expected);
            }

            await test_utils.assertErrorAsync(fs.access, [path.join(DEV_SCHEMA_PATH, 'test')], undefined);

            await test_utils.assertErrorAsync(fs.access, [path.join(DEV_SCHEMA_PATH, 'test2')], undefined);

            let drop_object = new DropAttributeObject('dev');
            await test_utils.assertErrorAsync(lmdb_drop_schema, [drop_object], undefined);

            search_table_results = await search_by_value(search_obj);
            assert.deepStrictEqual(search_table_results, []);

            search_attr_results = await search_by_value(search_attr_obj);
            assert.deepStrictEqual(search_attr_results, []);

            search_attr_results2 = await search_by_value(search_attr_obj2);
            assert.deepStrictEqual(search_attr_results2, []);

            let error;
            try{
                await fs.access(DEV_SCHEMA_PATH).catch(e=>{
                    error = e;
                });
            } catch (e) {
                let error = e;
            }

            assert.deepStrictEqual(error.message, "ENOENT: no such file or directory, access '/home/kyle/WebstormProjects/harperdb/unitTests/envDir/schema/dev'");

        });
    });
});