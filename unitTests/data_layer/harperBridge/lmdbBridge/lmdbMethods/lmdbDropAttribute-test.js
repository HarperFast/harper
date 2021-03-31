'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');

const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');
const TRANSACTIONS_NAME = 'transactions';
const BASE_TXN_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);

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

    before(async ()=>{
        await fs.remove(BASE_PATH);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        date_stub.restore();
    });

    describe('test dropAttributeFromSystem method', ()=>{
        let hdb_schema_env;
        let hdb_table_env;
        let hdb_attribute_env;
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

            hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

            hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

            hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);

            await lmdb_create_records(INSERT_OBJECT_TEST);
        });

        after(async () => {
            let env2 = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table);
            env2.close();

            let txn_env1 = await environment_utility.openEnvironment(path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table, true);
            txn_env1.close();

            hdb_table_env.close();
            hdb_schema_env.close();
            hdb_attribute_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test attribute not found', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'faker');
            await test_utils.assertErrorAsync(drop_attribute_from_system, [drop_object],
                new Error(`Attribute '${drop_object.attribute}' was not found in '${drop_object.schema}.${drop_object.table}'`));
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
        let hdb_schema_env;
        let hdb_table_env;
        let hdb_attribute_env;
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

            hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

            hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

            hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);

            await lmdb_create_records(INSERT_OBJECT_TEST);
        });

        after(async () => {
            let env2 = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table);
            env2.close();

            let txn_env1 = await environment_utility.openEnvironment(path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table, true);
            txn_env1.close();

            hdb_table_env.close();
            hdb_schema_env.close();
            hdb_attribute_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test removing temperature_str, pass invalid hash attribute', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            let tbl_env = await environment_utility.openEnvironment(DEV_SCHEMA_PATH, 'test');
            await test_utils.assertErrorAsync(remove_attribute_from_all_objects, [drop_object, tbl_env, 'faker'],
                LMDB_ERRORS.DBI_DOES_NOT_EXIST);
        });

        it('test removing temperature_str', async()=>{
            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            let tbl_env = await environment_utility.openEnvironment(DEV_SCHEMA_PATH, 'test');
            await test_utils.assertErrorAsync(remove_attribute_from_all_objects, [drop_object, tbl_env, 'id'], undefined);

            let search_results = search_utility.searchAll(tbl_env, 'id', ['id', 'temperature_str']);
            search_results.forEach(result =>{
                assert.notDeepStrictEqual(result.id, null);
                assert.deepStrictEqual(result.temperature_str, null);
            });
        });
    });

    describe('test lmdbDropAttribute method', ()=>{
        let hdb_schema_env;
        let hdb_table_env;
        let hdb_attribute_env;
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

            hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false, true);

            hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false, true);

            hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false, true);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);

            await lmdb_create_records(INSERT_OBJECT_TEST);
        });

        after(async () => {
            let env2 = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table);
            env2.close();

            let txn_env1 = await environment_utility.openEnvironment(path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table, true);
            txn_env1.close();

            hdb_table_env.close();
            hdb_schema_env.close();
            hdb_attribute_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test removing temperature_str', async()=>{
            let tbl_env = await environment_utility.openEnvironment(DEV_SCHEMA_PATH, 'test');
            let dbis = await test_utils.assertErrorAsync(environment_utility.listDBIs, [tbl_env], undefined);

            assert(dbis.indexOf('temperature_str') >= 0);

            let drop_object = new DropAttributeObject('dev', 'test', 'temperature_str');
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_object], undefined);

            let search_results = search_utility.searchAll(tbl_env, 'id', ['id', 'temperature_str']);
            search_results.forEach(result =>{
                assert.notDeepStrictEqual(result.id, null);
                assert.deepStrictEqual(result.temperature_str, null);
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
