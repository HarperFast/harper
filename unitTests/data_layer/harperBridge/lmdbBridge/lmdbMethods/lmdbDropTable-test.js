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
const lmdb_drop_table = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbDropTable');
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

const drop_table_from_system = lmdb_drop_table.__get__('dropTableFromSystem');

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

describe('test lmdbDropTable module', ()=>{
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

    describe('test dropTableFromSystem method', ()=>{
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

        it('test invalid schema', async()=>{
            let drop_object = new DropAttributeObject('faker', 'test');
            await test_utils.assertErrorAsync(drop_table_from_system, [drop_object],
                new Error(`${drop_object.schema}.${drop_object.table} was not found`));
        });

        it('test invalid table', async()=>{
            let drop_object = new DropAttributeObject('dev', 'fake');
            await test_utils.assertErrorAsync(drop_table_from_system, [drop_object],
                new Error(`${drop_object.schema}.${drop_object.table} was not found`));
        });

        it('test delete table metadata', async()=>{
            let search_obj = new SearchObject('system', 'hdb_table', 'name', 'test', undefined, ['*']);
            let search_table_results = await search_by_value(search_obj);
            let found_tbl;
            for(let x = 0; x < search_table_results.length; x++){
                if(search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test'){
                    found_tbl = search_table_results[x];
                }
            }
            assert.deepStrictEqual(`${found_tbl.schema}.${found_tbl.name}`, 'dev.test');

            let drop_object = new DropAttributeObject('dev', 'test');
            await test_utils.assertErrorAsync(drop_table_from_system, [drop_object], undefined);

            search_table_results = await search_by_value(search_obj);
            found_tbl = undefined;
            for(let x = 0; x < search_table_results.length; x++){
                if(search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test'){
                    found_tbl = search_table_results[x];
                }
            }

            assert.deepStrictEqual(found_tbl, undefined);

        });
    });

    describe('test lmdbDropTable method', ()=>{
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

        it('test invalid schema', async()=>{
            let drop_object = new DropAttributeObject('faker', 'test');
            await test_utils.assertErrorAsync(lmdb_drop_table, [drop_object],
                new Error(`unknown schema:faker and table test`));
        });

        it('test invalid table', async()=>{
            let drop_object = new DropAttributeObject('dev', 'fake');
            await test_utils.assertErrorAsync(lmdb_drop_table, [drop_object],
                new Error(`unknown schema:dev and table fake`));
        });

        it('test delete table', async()=>{
            let search_obj = new SearchObject('system', 'hdb_table', 'name', 'test', undefined, ['*']);
            let search_table_results = await search_by_value(search_obj);
            let found_tbl;
            for(let x = 0; x < search_table_results.length; x++){
                if(search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test'){
                    found_tbl = search_table_results[x];
                }
            }
            assert.deepStrictEqual(`${found_tbl.schema}.${found_tbl.name}`, 'dev.test');

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

            await test_utils.assertErrorAsync(fs.access, [path.join(DEV_SCHEMA_PATH, 'test')], undefined);

            let drop_object = new DropAttributeObject('dev', 'test');
            await test_utils.assertErrorAsync(lmdb_drop_table, [drop_object], undefined);

            search_table_results = await search_by_value(search_obj);
            found_tbl = undefined;
            for(let x = 0; x < search_table_results.length; x++){
                if(search_table_results[x].schema === 'dev' && search_table_results[x].name === 'test'){
                    found_tbl = search_table_results[x];
                }
            }

            assert.deepStrictEqual(found_tbl, undefined);

            search_attr_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['attribute']);
            search_attr_results = await search_by_value(search_attr_obj);
            assert.deepStrictEqual(search_attr_results, []);

            let error;
            try{
                await fs.access(path.join(DEV_SCHEMA_PATH, 'test')).catch(e=>{
                    error = e;
                });
            } catch (e) {
                let error = e;
            }

            assert.deepStrictEqual(error.message, "ENOENT: no such file or directory, access '/home/kyle/WebstormProjects/harperdb/unitTests/envDir/schema/dev/test'");
        });
    });
});