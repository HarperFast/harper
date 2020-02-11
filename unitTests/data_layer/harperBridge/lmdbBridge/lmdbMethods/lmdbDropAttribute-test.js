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
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const DropAttributeObject = require('../../../../../data_layer/DropAttributeObject');
const lmdb_drop_attribute = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbDropAttribute');
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

const drop_attribute_from_system = lmdb_drop_attribute.__get__('dropAttributeFromSystem');
const remove_attribute_from_all_objects = lmdb_drop_attribute.__get__('removeAttributeFromAllObjects');

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

describe('test lmdbDropAttribute module', ()=>{
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

    describe('test dropAttributeFromSystem method', ()=>{
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

            await lmdb_create_records(INSERT_OBJECT_TEST);
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test attribute not found', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'faker');
            await test_utils.assertErrorAsync(drop_attribute_from_system, [drop_object],
                new Error(`Attribute ${drop_object.attribute} was not found.`));
        });

        it('test drop temperature_str', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            let drop_results = await test_utils.assertErrorAsync(drop_attribute_from_system, [drop_object], undefined);
            assert(drop_results.deleted_hashes.length === 1);
            let search_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['*']);
            let results = await search_by_value(search_obj);

            results.forEach(result=>{
                assert.notDeepStrictEqual(result.attribute, 'temperature_str');
            });
        });
    });

    describe('test removeAttributeFromAllObjects method', ()=>{
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

            await lmdb_create_records(INSERT_OBJECT_TEST);
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test removing temperature_str, pass invalid hash attribute', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            let tbl_env = await environment_utility.openEnvironment(DEV_SCHEMA_PATH, 'test');
            test_utils.assertErrorSync(remove_attribute_from_all_objects, [drop_object, tbl_env, 'faker'],
                LMDB_ERRORS.DBI_DOES_NOT_EXIST);
        });

        it('test removing temperature_str', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            let tbl_env = await environment_utility.openEnvironment(DEV_SCHEMA_PATH, 'test');
            test_utils.assertErrorSync(remove_attribute_from_all_objects, [drop_object, tbl_env, 'id'], undefined);

            let search_results = search_utility.searchAll(tbl_env, 'id', ['id', 'temperature_str']);
            search_results.forEach(result =>{
                assert.notDeepStrictEqual(result.id, undefined);
                assert.deepStrictEqual(result.temperature_str, undefined);
            });
        });
    });

    describe('test lmdbDropAttribute method', ()=>{
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

            await lmdb_create_records(INSERT_OBJECT_TEST);
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test removing hash attribute column', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'id');
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_object],
                LMDB_ERRORS.CANNOT_DROP_TABLE_HASH_ATTRIBUTE);
        });

        it('test removing created timestamp column', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', '__createdtime__');
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_object],
                new Error('cannot drop internal timestamp attribute: __createdtime__'));
        });

        it('test removing updatedf timestamp column', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', '__updatedtime__');
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_object],
                new Error('cannot drop internal timestamp attribute: __updatedtime__'));
        });

        it('test removing temperature_str', async()=>{
            let tbl_env = await environment_utility.openEnvironment(DEV_SCHEMA_PATH, 'test');
            let dbis = await test_utils.assertErrorAsync(environment_utility.listDBIs, [tbl_env], undefined);

            assert(dbis.indexOf('temperature_str') >= 0);

            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_object], undefined);

            let search_results = search_utility.searchAll(tbl_env, 'id', ['id', 'temperature_str']);
            search_results.forEach(result =>{
                assert.notDeepStrictEqual(result.id, undefined);
                assert.deepStrictEqual(result.temperature_str, undefined);
            });

            dbis = await test_utils.assertErrorAsync(environment_utility.listDBIs, [tbl_env], undefined);

            assert(dbis.indexOf('temperature_str') < 0);

            let search_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['*']);
            let search_attr_results = await search_by_value(search_obj);

            search_attr_results.forEach(result=>{
                assert.notDeepStrictEqual(result.attribute, 'temperature_str');
            });
        });
    });
});